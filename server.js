const { Telegraf }      = require('telegraf');
const bodyParser        = require('body-parser');
const got               = require('got');
const moment            = require('moment');
const formData          = require('form-data');
const fs                = require('fs')
const parse             = require('node-html-parser').parse;
const config            = require('./config');
const { Pool, Client }  = require('pg');
const CronJob           = require('cron').CronJob;
require('dotenv').config();

const WEBHOOK = `${config.ngrok}/webhook/${config.botToken}`;
const bot = new Telegraf(config.botToken);

let COURSES;

const client = new Client({
  user: config.db.user,
  host: config.db.host,
  database: config.db.name,
  password: config.db.password,
  port: config.db.port,
})
client.connect();


const checkNewBookings = new CronJob('*/10 * * * * *', async function() {
    COURSES.forEach(course => {
        logPageCheck(course.id);
        getCourseBookings(course.id, bookings => {
            bookings.forEach(book => {
                bookCourse(book.requestData).then(() => {
                    saveNewBooking(book);
                    config.allowedChatIds.forEach(chatId => {
                        bot.telegram.sendMessage(chatId, `Prenotato il corso ${course.nome} il giorno ${book.date} in aula ${book.room}`);
                    });
                }).catch(() => {
                    console.error(`Error while booking course: ${course.id}`);
                });
            });
        });
    });
}, null, false, 'Europe/Rome');


const saveNewBooking = function (booking) {
    const query = `
        insert into prenotazioni(id_corso, data_prenotazione, data_inizio, data_fine, aula)
        values ($1::int4, $2::timestamp, $3::timestamptz, $4::timestamptz, $5::text)
    `;

    const [courseDate, courseTime] = booking.date.split(" ");
    const startDate = parseDate(courseDate, courseTime.split("-")[0])
    const endDate = parseDate(courseDate, courseTime.split("-")[1])
    client.query(query, [booking.requestData.idModulo, moment(), startDate, endDate, booking.room]);
};


const logPageCheck = function (courseId) {
    const query = `
        insert into controllo_corsi(id_corso, data_controllo)
        values ($1::int4, now()::timestamp)
    `;
    client.query(query, [courseId]);
};


const getActiveBookings = function(cb) {
    const query = `
        select c.nome, data_inizio, data_fine, aula
        from prenotazioni p join corsi c on p.id_corso = c.id
        where data_inizio > now()
    `;
    return client.query(query);
}


const bookCourse = async function(courseInfo) {
    return new Promise((resolve, reject) => {
        var form = new formData();
        form.append('userid', config.userId);
        form.append('IdModulo', courseInfo.idModulo);
        form.append('dateP', courseInfo.dateP);
        form.append('IdOrario', courseInfo.idOrario);
        form.append('numberP', courseInfo.numberP);
        form.append('IdPrenotazione', courseInfo.idPrenotazione);
        form.append('action', 'prenota_corso');

        got.post(config.uniPageUrl, {body: form}).then(() => {
            resolve();
        }).catch((err)=>{
            reject(err);
        });
    }, courseInfo);
};


const getCoursesDetails = async function(courses) {
    const res = await client.query(`select * from corsi where id in (${courses.join(",")})`);
    return res.rows;
};


const getCourseBookings = async function(courseId, cb) {
    var form = new formData();
    form.append('userid', config.userId);
    form.append('IdModulo', courseId);
    form.append('action', 'dettaglio_corso');

    const res = await got.post(config.uniPageUrl, {body: form});
    cb(parseCoursePage(courseId, res.body));
};


const parseCoursePage = function(courseId, page) {
    const bookings = []
    const fields = ["date", "room", "availability"];
    let arrIndex = 0;

    const root = parse(page);
    root.querySelector('tbody').childNodes.forEach((tr) => {
        if (tr.childNodes.length === 0)
            return;

        const booking = {};
        arrIndex = 0;
        tr.childNodes.forEach((trc) => {
            if (trc.childNodes.length === 0 || arrIndex > 2 || trc.rawTagName ==! 'TD')
                return;

            const tableText = trc.text.trim();
            switch (true) {
                case (tableText.match(/^[0-9\-:\s]+$/) != null):
                    booking.date = tableText;
                    break;
                case (tableText.match(/^Aula/, "i") != null):
                    booking.room = tableText;
                    break;
                case (tableText === 'prenota'):
                    if (trc.rawAttrs.match(/posti esauriti/)) {
                        booking.availability = false;
                    } else {
                        booking.availability = true;
                        const requestParams = trc.toString()
                                                .match(/prenota\(([^\)]+)\)/)[1].split(",")
                                                .map(el => el.replace(new RegExp(/"/, "gm"), ""));
                        const [idModulo, dateP, idOrario, numberP, idPrenotazione] = requestParams;
                        const requestData = {idModulo, dateP, idOrario, numberP, idPrenotazione};
                        requestData.action = "prenota_corso";
                        requestData.rand = Math.random();

                        booking.requestData = requestData;
                    }
                    break;
                case (tableText === 'annulla'):
                    booking.availability = false;
                    break;
                default:
                    return;
            }
        });
        bookings.push(booking);
    });
    return bookings.filter(el => el.availability);
};

const parseDate = function(dateStr, timeStr) {
    const [dd, mm, yy] = dateStr.split("-");
    const dateTime = (timeStr !== undefined) ? ` ${timeStr}` : ``;
    return moment(`${yy}-${mm}-${dd}${dateTime}`);
};

const blockUnauthorized = () => (ctx, next) => {
    if (config.allowedChatIds.indexOf(ctx.chat.id.toString()) > -1) {
        next();
    } else {
        ctx.reply("Utente non autorizzato");
    }
};
bot.use(blockUnauthorized());

bot.command('/hello', (ctx) => {
    ctx.reply('Hello!');
});

bot.command('/attiva_prenotazioni', async (ctx) => {
    if (COURSES === undefined) {
        COURSES = await getCoursesDetails(config.courses);
    }
    checkNewBookings.start();
    config.allowedChatIds.forEach(chatId => {
        bot.telegram.sendMessage(chatId, 'Scansione avviata');
    });
});

bot.command('/ferma_prenotazioni', (ctx) => {
    checkNewBookings.stop();
    config.allowedChatIds.forEach(chatId => {
        bot.telegram.sendMessage(chatId, 'Scansione arrestata');
    });
});

bot.command('/lista_prenotazioni', async (ctx) => {
    getActiveBookings().then((res) => {
        if (res.rowCount === 0) {
            ctx.reply('Nessuna prenotazione attiva');
        } else {
            let replyStr = '';
            for (booking of res.rows) {
                replyStr = `${replyStr}\n- ${booking.nome}, ${moment(booking.data_inizio).locale('it').format("DD/MM/YYYY HH:mm")}, ${booking.aula}`;
            }
            ctx.replyWithMarkdown(replyStr);
        }
    });
});

bot.on('text', (ctx) => {
    // do something ?
});

bot.launch({
  webhook: {
    domain: WEBHOOK,
    port: config.serverPort
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
