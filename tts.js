const {
    SpeechSynthesisOutputFormat,
} = require('microsoft-cognitiveservices-speech-sdk')
const sdk = require('microsoft-cognitiveservices-speech-sdk')
const { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION } = require('./config')

const DEFAULT_VOICE = 'en-US-JennyMultilingualNeural'

module.exports = {
    synthesize,
    DEFAULT_VOICE,
}

// Returns local voice .ogg path
async function synthesize(messageId, text, voice = DEFAULT_VOICE) {
    voice = voice || DEFAULT_VOICE
    console.log(
        `[synthesize] sending voice synthesize request. messageId=${messageId} text length="${text.length}" voice=${voice}`,
    )
    const speechConfig = sdk.SpeechConfig.fromSubscription(
        AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION,
    )
    // TODO: Try other bitrates.
    speechConfig.speechSynthesisOutputFormat =
        // SpeechSynthesisOutputFormat.Audio16Khz16Bit32KbpsMonoOpus
        SpeechSynthesisOutputFormat.Ogg16Khz16BitMonoOpus
    const localOggPath = require('path').join(
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
                synthesizer = null
            },
            (err) => {
                console.log(
                    `[synthesize] synthesize errored received after ${
                        Date.now() - start
                    }ms`,
                )
                reject(err)
                synthesizer.close()
                synthesizer = null
            },
        )
    })
}

// async function run() {
//     const result = await synthesize('xxx', 'Hola, mi nombre es Peluche.')
//     console.log(result)
// }
// run().catch(console.error)
