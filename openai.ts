import { Configuration, OpenAIApi } from 'openai'
import { OPENAI_API_KEY, MASTER_PROMPT } from './config'
import { Readable } from 'stream'
import * as util from './util'
import * as db from './db'

const openai = new OpenAIApi(
    new Configuration({
        apiKey: OPENAI_API_KEY,
    }),
)

// stream should be an mp3 audio stream.
//
// https://github.com/openai/openai-node/issues/77
export async function transcribeAudio(mp3Stream: Readable) {
    // Library rejects our stream unless it has path property.
    // Note: fs.createReadStream(path) has a path property which is how I figured this out.
    //@ts-expect-error
    mp3Stream.path = 'upload.mp3'
    //@ts-expect-error
    return openai.createTranscription(mp3Stream, 'whisper-1')
}

export async function* streamChatCompletions(
    messages: db.Message[],
    temperature: number,
): AsyncGenerator<string> {
    const response = await openai.createChatCompletion(
        {
            model: 'gpt-3.5-turbo',
            messages,
            temperature,
            stream: true,
        },
        {
            responseType: 'stream',
        },
    )

    //@ts-expect-error
    for await (const chunk of response.data) {
        const lines = chunk
            .toString('utf8')
            .split('\n')
            .filter((line: string) => line.trim().startsWith('data: '))

        for (const line of lines) {
            const message = line.replace(/^data: /, '')
            if (message === '[DONE]') {
                return
            }

            const json = JSON.parse(message)
            const token = json.choices[0].delta.content
            if (token) {
                yield token
            }
        }
    }
}

module.exports.fetchChatResponse = async function (
    messages: db.Message[],
    temperature: number,
) {
    console.log(
        `[fetchChatResponse] making chatgpt request with ${
            messages.length - 1
        } history answers and 1 user prompt. (temp=${temperature.toFixed(1)})`,
    )
    const start = Date.now()
    const response = await openai.createChatCompletion(
        {
            model: 'gpt-3.5-turbo',
            messages,
            temperature, // 0 to 2.0, anything about 1.0 is nonsense
        },
        // Tell Axios not to fail on some http status errors
        {
            validateStatus(status) {
                if (status >= 200 && status < 300) {
                    return true
                } else if (status === 429) {
                    return true
                } else {
                    return false
                }
            },
        },
    )

    // TODO: On error, print axios error.data which will contain the error message.

    console.log(
        `[fetchChatResponse] (${Date.now() - start}ms) chatgpt response: ${
            response.data.choices[0].message.content.length
        } chars..`,
        response.data.usage,
    )

    return {
        response,
        elapsed: Date.now() - start,
    }
}

type LanguageResult =
    | { kind: 'unknown' }
    | { kind: 'success'; code: string }
    | { kind: 'error'; error: string }

// GPT-3 is defeated by "This is some text written in French." but it doesn't really matter since
// it's only used on ChatGPT answers.
const prompt = `Determine the two-letter ISO 639-1 language code for the following text. If you recognize the language, respond with the two-letter code (e.g., "en" for English, "es" for Spanish) and NOTHING else. If you don't recognize the language, respond with a "?". The text: `

export async function detectLanguage(
    text: string,
): Promise<LanguageResult | undefined> {
    const substring = util.splitTake(300, text)
    const fullPrompt = prompt + '```' + substring + '```'
    const response = await openai.createChatCompletion(
        {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: fullPrompt }],
            max_tokens: 1,
            temperature: 0,
        },
        {
            validateStatus() {
                return true
            },
        },
    )
    console.log(`[detectLanguage] <-- response returned`)
    if (response.status !== 200) {
        return {
            kind: 'error',
            error: `OpenAI API had non-ok response: ${response.status} ${response.statusText}`,
        }
    }
    const answer = await response.data.choices[0].message.content
    if (answer === '?') {
        return { kind: 'unknown' }
    } else if (answer.length === 2) {
        return { kind: 'success', code: answer.toLowerCase() }
    } else {
        return { kind: 'error', error: `unexpected answer: ${answer}` }
    }
}
