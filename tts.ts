import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } from './config'
import { Readable } from 'stream'

export const DEFAULT_VOICE = 'en-US-JennyMultilingualNeural'

export async function synthesize(
    messageId: number,
    text: string,
    voice = DEFAULT_VOICE,
): Promise<{
    elapsed: number
    byteLength: number
    readable: Readable
}> {
    voice = voice || DEFAULT_VOICE
    console.log(
        `[synthesize] sending voice synthesize request. messageId=${messageId} text length="${text.length}" voice=${voice}`,
    )
    console.log({ AZURE_SPEECH_KEY, AZURE_SPEECH_REGION })
    const speechConfig = sdk.SpeechConfig.fromSubscription(
        AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION,
    )
    // TODO: Try other bitrates.
    speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Ogg16Khz16BitMonoOpus
    speechConfig.speechSynthesisVoiceName = voice

    const pullStream = sdk.PullAudioOutputStream.createPullStream()
    const audioConfig = sdk.AudioConfig.fromStreamOutput(pullStream)

    let synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig)

    return new Promise((resolve, reject) => {
        const start = Date.now()
        synthesizer.speakTextAsync(
            text,
            async (result) => {
                synthesizer.close()
                console.log(
                    `[synthesize] synthesize response received after ${
                        Date.now() - start
                    }ms`,
                )
                if (
                    result.reason ===
                    sdk.ResultReason.SynthesizingAudioCompleted
                ) {
                    const readable = new PullStreamReadable(pullStream)
                    resolve({
                        //@ts-ignore
                        byteLength: result.privAudioData.byteLength,
                        elapsed: Date.now() - start,
                        readable,
                    })
                } else {
                    reject(
                        new Error(
                            'Speech synthesis canceled, ' +
                                result.errorDetails +
                                '\nDid you set the speech resource key and region values?',
                        ),
                    )
                }
            },
            (err) => {
                synthesizer.close()
                console.log(
                    `[synthesize] synthesize errored received after ${
                        Date.now() - start
                    }ms`,
                )
                reject(err)
            },
        )
    })
}

async function readDataFromPullStream(pullStream) {
    const data = []
    const buffer = new ArrayBuffer(1024)
    let bytesRead

    do {
        bytesRead = await pullStream.read(buffer)
        if (bytesRead > 0) {
            data.push(new Uint8Array(buffer.slice(0, bytesRead)))
        }
    } while (bytesRead > 0)

    return new Uint8Array([].concat(...data))
}

// Wrap Azure sdk's pull stream with a Node Readable stream so we
// can use it elsewhere, like in `fetch`.
class PullStreamReadable extends Readable {
    private pullStream: sdk.PullAudioOutputStream

    constructor(pullStream) {
        super()
        this.pullStream = pullStream
    }

    async _read(size: number) {
        const buffer = new ArrayBuffer(size)
        const bytesRead = await this.pullStream.read(buffer)

        if (bytesRead > 0) {
            this.push(new Uint8Array(buffer.slice(0, bytesRead)))
        } else {
            // end of stream
            this.push(null)
        }
    }
}
