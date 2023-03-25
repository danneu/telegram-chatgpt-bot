import * as cp from 'child_process'

export async function spawn(cmd: string, args: string[]) {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(cmd, args)

        let stderrBuf = ''
        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (data) => {
            stderrBuf += data
        })

        let stdoutBuf = ''
        proc.stdout.on('data', (data) => {
            stdoutBuf += data
        })

        proc.on('close', (code: number) => {
            code === 0 ? resolve(stdoutBuf) : reject(stderrBuf)
        })
    })
}
