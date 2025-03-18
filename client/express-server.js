const express = require("express");
const app = express();
const PORT = 8080;

// ✅ Set CSP Headers Manually
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", 
        "default-src 'self' http://localhost:3000; " +
        "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.socket.io; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' ws://localhost:3000 ws://127.0.0.1:3000 wss://localhost:3000;"
    );
    next();
});

// ✅ Serve Static Files
app.use(express.static(__dirname));

app.listen(PORT, () => console.log(`🚀 Static Server running at http://localhost:${PORT}`));