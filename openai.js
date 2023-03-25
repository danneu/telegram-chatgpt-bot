const { Configuration, OpenAIApi } = require('openai')
const { OPENAI_API_KEY, MASTER_PROMPT } = require('./config')

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
module.exports.transcribeAudio = async function (readStream) {
    return openai.createTranscription(readStream, 'whisper-1')
}

module.exports.streamChatCompletions = async function* (
    history,
    prompt,
    temperature,
) {
    const messages = [
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

    for await (const chunk of response.data) {
        const lines = chunk
            .toString('utf8')
            .split('\n')
            .filter((line) => line.trim().startsWith('data: '))

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
    history,
    prompt,
    temperature,
) {
    const messages = [
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
            response.data.choices[0].message.content.length
        } chars..`,
        response.data.usage,
    )

    return {
        response,
        elapsed: Date.now() - start,
    }
}
