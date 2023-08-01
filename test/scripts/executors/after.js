const { unlink } = require("fs/promises");
const after = async () => {
    if (!process.env.TEST_LOCAL) {
        await unlink("test-env.json");
    }
}

module.exports = after();