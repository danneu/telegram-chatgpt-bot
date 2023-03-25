import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } from './config'
import { join } from 'path'

export const DEFAULT_VOICE = 'en-US-JennyMultilingualNeural'

// Returns local voice .ogg path
export async function synthesize(
    messageId: number,
    text: string,
    voice = DEFAULT_VOICE,
): Promise<{
    path: string
    elapsed: number
    byteLength: number
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
    console.log({ speechConfig })
    // TODO: Try other bitrates.
    speechConfig.speechSynthesisOutputFormat =
        // SpeechSynthesisOutputFormat.Audio16Khz16Bit32KbpsMonoOpus
        sdk.SpeechSynthesisOutputFormat.Ogg16Khz16BitMonoOpus
    const localOggPath = join(
        __dirname,
        'tmp',
        'answer-voice',
        messageId + '.ogg',
    )
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(localOggPath)
    speechConfig.speechSynthesisVoiceName = voice

    let synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig)

    return new Promise((resolve, reject) => {
        const start = Date.now()
        synthesizer.speakTextAsync(
            text,
            (result) => {
                console.log(
                    `[synthesize] synthesize response received after ${
                        Date.now() - start
                    }ms`,
                )
                if (
                    result.reason ===
                    sdk.ResultReason.SynthesizingAudioCompleted
                ) {
                    // console.log(`[synthesize] result:`, result)
                    resolve({
                        //@ts-ignore
                        byteLength: result.privAudioData.byteLength,
                        elapsed: Date.now() - start,
                        path: localOggPath,
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
                synthesizer.close()
            },
            (err) => {
                console.log(
                    `[synthesize] synthesize errored received after ${
                        Date.now() - start
                    }ms`,
                )
                reject(err)
                synthesizer.close()
            },
        )
    })
}

// async function run() {
//     const result = await synthesize('xxx', 'Hola, mi nombre es Peluche.')
//     console.log(result)
// }
// run().catch(console.error)
