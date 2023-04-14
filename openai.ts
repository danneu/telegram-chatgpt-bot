import {
    Configuration,
    type CreateTranslationResponse,
    OpenAIApi,
} from 'openai'
import { OPENAI_API_KEY } from './config'
import { type Readable } from 'stream'
import * as util from './util'
import type * as db from './db'
import { type AxiosResponse } from 'axios'

const openai = new OpenAIApi(
    new Configuration({
        apiKey: OPENAI_API_KEY,
    }),
)

// stream should be an mp3 audio stream.
//
// https://github.com/openai/openai-node/issues/77
export async function transcribeAudio(
    mp3Stream: Readable,
): Promise<AxiosResponse<CreateTranslationResponse, any>> {
    // Note: fs.createReadStream(path) has a path property which is how I figured this out.
    // @ts-expect-error: Library rejects our stream unless it has path property.
    mp3Stream.path = 'upload.mp3'
    // @ts-expect-error: Readable not assignable to File argument
    return await openai.createTranscription(mp3Stream, 'whisper-1')
}

export async function* streamChatCompletions(
    messages: db.Message[],
    model: 'gpt-3.5-turbo' | 'gpt-4',
    temperature: number,
): AsyncGenerator<string> {
    const response = await openai.createChatCompletion(
        {
            model,
            messages,
            temperature,
            stream: true,
        },
        {
            responseType: 'stream',
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

    // @ts-expect-error: Not sure how to annotate the fact that data is async iterator.
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
            if (typeof token === 'string' && token.length > 0) {
                yield token
            }
        }
    }
}

module.exports.fetchChatResponse = async function (
    messages: db.Message[],
    temperature: number,
    model: 'gpt-3.5-turbo' | 'gpt-4',
) {
    console.log(
        `[fetchChatResponse] making chatgpt request with ${
            messages.length - 1
        } history answers and 1 user prompt. (temp=${temperature.toFixed(1)})`,
    )
    const start = Date.now()
    const response = await openai.createChatCompletion(
        {
            model,
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

    // console.log(
    //     `[fetchChatResponse] (${Date.now() - start}ms) chatgpt response: ${
    //         response.data.choices[0].message.content.length
    //     } chars..`,
    //     response.data.usage,
    // )

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

// TODO: Consider using Ada or Babbage which are cheap and fast.
export async function detectLanguage(text: string): Promise<LanguageResult> {
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
    if (response.status !== 200) {
        return {
            kind: 'error',
            error: `OpenAI API had non-ok response: ${response.status} ${response.statusText}`,
        }
    }
    const answer = response.data?.choices[0].message?.content ?? ''
    if (answer === '?') {
        return { kind: 'unknown' }
    } else if (answer.length === 2) {
        return { kind: 'success', code: answer.toLowerCase() }
    } else {
        return { kind: 'error', error: `unexpected answer: ${answer}` }
    }
}

export async function textCompletion(
    prompt: string,
    temperature: number,
): Promise<string> {
    const response = await openai.createCompletion({
        model: 'text-davinci-003',
        prompt,
        temperature,
        max_tokens: 1024,
    })
    console.log(response.data)
    const answer = response.data.choices[0].text
    if (typeof answer === 'string') {
        return answer
    } else {
        throw new Error(`textCompletion failed to get answer`)
    }
}

export async function* streamTextCompletions(
    prompt: string,
    temperature: number,
): AsyncGenerator<string> {
    const response = await openai.createCompletion(
        {
            model: 'text-davinci-003',
            temperature,
            prompt,
            max_tokens: 1024,
            stream: true,
        },
        {
            responseType: 'stream',
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

    // @ts-expect-error: Not sure how to annotate the fact that data is async iterator.
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
            const token = json.choices[0].text
            if (typeof token === 'string' && token.length > 0) {
                yield token
            }
        }
    }
}

type Status = typeof OpenAIError.Statuses[number]

export class OpenAIError extends Error {
    // message will be user-friendly error message
    constructor(readonly status: Status) {
        let message: string
        switch (status) {
            case 400:
                message = `❌ OpenAI: Bad request. Ensure the prompt is SFW.`
                break
            case 429:
                message = `❌ OpenAI: Rate-limited`
                break
        }
        super(message)
    }

    // The status codes that Axios will not fail on.
    //
    // 429: Rate-limited
    // 400: Bad request, usually NSFW prompt
    static Statuses = [429, 400] as const

    static isStatus(status: number): status is Status {
        return this.Statuses.includes(status as Status)
    }
}

// Note: urls point to png images.
export async function dalleGenerateImages(
    prompt: string,
    count: number,
): Promise<URL[]> {
    const response = await openai.createImage(
        {
            prompt,
            n: count,
            size: '1024x1024',
        },
        {
            validateStatus(status) {
                if (status >= 200 && status < 300) {
                    return true
                } else if (OpenAIError.isStatus(status)) {
                    return true
                } else {
                    return false
                }
            },
        },
    )

    if (response.status >= 200 && response.status < 300) {
        const body = response.data
        const urls = body.data.map((item: any) => new URL(item.url))
        return urls
    } else if (OpenAIError.isStatus(response.status)) {
        throw new OpenAIError(response.status)
    } else {
        throw new Error('Unhandled case')
    }
}

// Uses private API.
//
// Returns undefined if API fails so it can be easily discarded.
export async function getMonthUsage(): Promise<number | undefined> {
    function formatDate(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${date.getFullYear()}-${month}-${day}`
    }

    const now = new Date()
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1)
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const url = `https://api.openai.com/dashboard/billing/usage?start_date=${formatDate(
        startDate,
    )}&end_date=${formatDate(endDate)}`

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        referrer: 'https://platform.openai.com/',
    })

    if (response.status !== 200) {
        return
    }

    const body = await response.json()
    const usd = body.total_usage / 100
    return usd
}
