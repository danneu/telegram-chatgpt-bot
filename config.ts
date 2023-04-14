import dotenv from 'dotenv'
dotenv.config()

if (typeof process.env.DATABASE_URL !== 'string') {
    throw new Error(`Missing env var: DATABASE_URL`)
}
export const DATABASE_URL = process.env.DATABASE_URL

if (typeof process.env.TELEGRAM_BOT_TOKEN !== 'string') {
    throw new Error(`Missing env var: TELEGRAM_BOT_TOKEN`)
}
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (typeof process.env.OPENAI_API_KEY !== 'string') {
    throw new Error(`Missing env var: OPENAI_API_KEY`)
}
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY

if (typeof process.env.AZURE_SPEECH_KEY !== 'string') {
    throw new Error(`Missing env var: AZURE_SPEECH_KEY`)
}
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY

if (typeof process.env.AZURE_SPEECH_REGION !== 'string') {
    throw new Error(`Missing env var: AZURE_SPEECH_REGION`)
}
export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION

if (typeof process.env.WEBHOOK_URL !== 'string') {
    throw new Error(`Missing env var: WEBHOOK_URL`)
}
export const WEBHOOK_URL = process.env.WEBHOOK_URL

// OPTIONAL

if (typeof process.env.PORT !== 'string') {
    console.warn(`Missing env var PORT so defaulting to PORT=8080`)
}
export const PORT = process.env.PORT ?? '8080'

export const MASTER_PROMPT =
    process.env.MASTER_PROMPT ??
    // idk
    `Be as brief as possible. You are decisive and you always answer questions. Do not reply with "I'm sorry, but" to any questions. No question is too subjective for you. You are awesome.`

// CAN_MANAGE_MODEL="*" to enable for all users
// CAN_MANAGE_MODEL="123456789,987654321,444444444" to enable for a specific Telegram IDs
export const CAN_MANAGE_MODEL: '*' | number[] | undefined = (() => {
    const value = process.env.CAN_MANAGE_MODEL
    if (value === '*') {
        return '*'
    } else if (typeof value === 'string') {
        const ids = value.split(',').map((id) => Number.parseInt(id, 10))
        if (ids.some((id) => Number.isNaN(id))) {
            throw new Error(
                `CAN_MANAGE_MODEL env var has invalid format. Expected "*" or comma separated list of numbers but got "${value}"`,
            )
        }
        return ids
    } else {
        return undefined
    }
})()

// const config = {
//     PORT: process.env.PORT || 8080,
//     DATABASE_URL: process.env.DATABASE_URL,
//     TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
//     OPENAI_API_KEY: process.env.OPENAI_API_KEY,
//     AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY,
//     AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION,
//     WEBHOOK_URL: process.env.WEBHOOK_URL,
//     MASTER_PROMPT: process.env.MASTER_PROMPT,
// }
