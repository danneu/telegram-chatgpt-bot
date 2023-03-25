const { spawn } = require('child_process')

module.exports = async function countTokens(text) {
    const proc = spawn('python3', ['count_tokens.py', text])

    return new Promise((resolve, reject) => {
        let buf = ''

        proc.stdout.on('data', (data) => {
            buf += data
        })

        proc.stderr.on('data', (data) => {
            reject(new Error(`Error calling count_tokens.py: ${data}`))
        })

        proc.on('close', () => {
            resolve(Number.parseInt(buf, 10))
        })
    })
}
