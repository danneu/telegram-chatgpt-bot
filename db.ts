import pg from 'pg'
import * as types from './types'
import { DATABASE_URL } from './config'
import assert from 'assert'

export type User = {
    id: number
    uname: string
    lang: string | undefined
}

export type Chat = {
    id: number
    voice: string | undefined
    send_voice: boolean
    temperature: number
}

// Tell pg to parse numeric column as float.
pg.types.setTypeParser(1700, (val) => Number.parseFloat(val))

const pool = new pg.Pool({
    connectionString: DATABASE_URL,
})

async function one(pool: pg.Pool, stmt: string, params: any[]) {
    const result = await pool.query(stmt, params)
    return result.rows[0]
}

export async function clearPrompts(userId: number) {
    return pool.query(
        `
    delete from prompts
    where user_id = $1
    `,
        [userId],
    )
}

export async function upsertUser(
    id: number,
    uname: string,
    lang: string | undefined,
): Promise<User> {
    console.log(`[upsertUser] id=${id}`)
    const user = await one(
        pool,
        `
    insert into users (id, uname, lang)
    values ($1, $2, $3)
    on conflict (id) do update 
    set uname = $2,
        lang = $3
    returning *
    `,
        [id, uname, lang],
    )

    return user
}

export async function setVoiceResponse(chatId: number, isEnabled: boolean) {
    return pool.query(
        `
        update chats
        set send_voice = $2
        where id = $1
        `,
        [chatId, isEnabled],
    )
}

export async function upsertChat(
    id: number,
    type: string,
    uname: string,
): Promise<Chat> {
    console.log(`[upsertChat] id=${id}`)
    return one(
        pool,
        `insert into chats (id, type, uname)
        values ($1, $2, $3)
        on conflict (id) do update
        set uname = $3
        returning *
        `,
        [id, type, uname],
    )
}

export async function changeVoice(chatId: number, voiceCode: string) {
    return one(
        pool,
        `
update chats
set voice = $2
where id = $1
returning *
    `,
        [chatId, voiceCode],
    )
}

export async function setTtsElapsed(promptId: number, elapsed: number) {
    assert(Number.isInteger(promptId))
    assert(Number.isInteger(elapsed))
    return pool.query(
        `
    update prompts
    set tts_elapsed = $2
    where id = $1
    `,
        [promptId, elapsed],
    )
}

export async function insertAnswer({
    userId,
    chatId,
    prompt,
    messageId,
    answer,
    promptTokens,
    answerTokens,
    gptElapsed,
}: {
    userId: number
    chatId: number
    prompt: string
    messageId: number
    answer: string
    promptTokens: number
    answerTokens: number
    gptElapsed: number | undefined
}) {
    return one(
        pool,
        `
    insert into prompts (chat_id, user_id, prompt, message_id, answer, prompt_tokens, answer_tokens, gpt_elapsed)
    values ($1, $2, $3, $4, $5, $6, $7, $8)
    returning *
`,
        [
            chatId,
            userId,
            prompt,
            messageId,
            answer,
            promptTokens,
            answerTokens,
            gptElapsed,
        ],
    )
}

export async function setTemperature(chatId: number, temperature: number) {
    assert(Number.isInteger(chatId), 'chatId must be integer')
    assert(typeof temperature === 'number', 'temperature must be number')
    return pool.query(
        `
    update chats
    set temperature = $2
    where id = $1
    `,
        [chatId, temperature],
    )
}

export async function listHistory(userId: number, chatId: number) {
    const { rows }: { rows: types.Prompt[] } = await pool.query(
        `
        select * from prompts
        where user_id = $1
          and chat_id = $2
          and length(prompt) > 0
        order by id desc
        limit 20
    `,
        [userId, chatId],
    )

    // The token budget of 4096 is a sum of historical message tokens + user prompt + ChatGPT answer.
    // This means that the following code tries to load 4096-512 tokens of historical messages
    // and leaves 512 tokens between the user prompt (usually short in the Telegram chat setting) and
    // ChatGPT's answer.
    let budget = 4096 - 512
    let output: types.Message[] = []
    for (const row of rows) {
        if (budget - row.answer_tokens < 0) {
            break
        }
        budget -= row.answer_tokens
        output.push({
            role: 'assistant',
            content: row.answer,
        })

        if (budget - row.prompt_tokens < 0) {
            break
        }
        budget -= row.prompt_tokens
        output.push({
            role: 'user',
            content: row.prompt,
        })
    }

    return output.reverse()
}
