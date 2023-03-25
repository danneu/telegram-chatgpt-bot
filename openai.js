const { Configuration, OpenAIApi } = require('openai')
const { OPENAI_API_KEY } = require('./config')

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

module.exports.fetchChatResponse = async function (
    history,
    prompt,
    temperature,
) {
    const messages = [
        // Not sure if this system prompt even does anything, but I want to:
        // 1. Avoid ChatGPT's disclaimer-heavy responses.
        // 2. Encourage brevity since it's for Telegram.
        {
            role: 'system',
            content:
                'You are a helpful AI that gives brief answers. You answer questions without any disclaimers. If you are unsure of something, do not tell the user. Instead, just make a guess.',
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

    return response
}
