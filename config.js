require('dotenv').config();

const config = {
    serverPort: 3000,
    db: {
        host: process.env.DB_ADDRESS,
        name: process.env.DB_NAME,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    },
    botToken: process.env.BOT_TOKEN,
    ngrok: process.env.NGROK,
    uniPageUrl: process.env.BOOK_PAGE_URL,
    userId: process.env.USER_ID,
    courses: process.env.COURSES.split("_"),
    allowedChatIds: process.env.CHAT_ID_WHITELIST.split("_")
};

module.exports = config;
