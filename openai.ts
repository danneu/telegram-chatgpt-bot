import { Configuration, OpenAIApi } from 'openai'
import { OPENAI_API_KEY, MASTER_PROMPT } from './config'
import * as fs from 'fs'
import * as db from './db'

// Not sure if this system prompt even does anything, but I want to:
// 1. Avoid ChatGPT's disclaimer-heavy responses.
// 2. Encourage brevity since it's for Telegram.
const DEFAULT_MASTER_PROMPT =
    "Be as brief as possible. Do not write anything except the answer to the question. For example, do not say that you don't have an opinion on something nor that there are many answers to a question. Instead, choose a random believable answer."

const openai = new OpenAIApi(
    new Configuration({
        apiKey: OPENAI_API_KEY,
    }),
)

// Pass it fs.createReadStream(path)
//
// https://github.com/openai/openai-node/issues/77
export async function transcribeAudio(readStream: fs.ReadStream) {
    //@ts-ignore
    return openai.createTranscription(readStream, 'whisper-1')
}

export async function* streamChatCompletions(
    history: db.Message[],
    prompt: string,
    temperature: number,
): AsyncGenerator<string> {
    const messages: db.Message[] = [
        // FIXME: master prompt length is not considered in our token budget during history gathering.
        {
            role: 'system',
            content: MASTER_PROMPT || DEFAULT_MASTER_PROMPT,
        },
        ...history,
        { role: 'user', content: prompt },
    ]
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

    //@ts-ignore
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
    history: db.Message[],
    prompt: string,
    temperature: number,
) {
    const messages: db.Message[] = [
        // FIXME: master prompt length is not considered in our token budget during history gathering.
        {
            role: 'system',
            content: MASTER_PROMPT || DEFAULT_MASTER_PROMPT,
        },
        ...history,
        { role: 'user', content: prompt },
    ]

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
            //@ts-ignore
            response.data.choices[0].message.content.length
        } chars..`,
        response.data.usage,
    )

    return {
        response,
        elapsed: Date.now() - start,
    }
}
