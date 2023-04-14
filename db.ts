import pg from 'pg'
import { DATABASE_URL } from './config'
import assert from 'assert'
import { countTokens } from './tokenizer'

// Tell pg to parse numeric column as float.
pg.types.setTypeParser(1700, (val) => Number.parseFloat(val))
// Javascript can handle 52-bit integers from Telegram even though we store them
// in larger types in the database.
pg.types.setTypeParser(pg.types.builtins.INT8, (val) =>
    Number.parseInt(val, 10),
)

const pool = new pg.Pool({
    connectionString: DATABASE_URL,
})

async function one(pool: pg.Pool, stmt: string, params: any[]): Promise<any> {
    const result = await pool.query(stmt, params)
    return result.rows[0]
}

export async function clearPrompts(userId: number): Promise<void> {
    await pool.query(
        `
    delete from prompts
    where user_id = $1
    `,
        [userId],
    )
}

export async function getPrevPrompt(chatId: Chat['id']): Promise<Prompt> {
    const prompt: Prompt = await one(
        pool,
        `
    select * from prompts
    where chat_id = $1
    order by id desc
    limit 1
    `,
        [chatId],
    )

    return prompt
}

export async function upsertUser(
    id: number,
    uname: string,
    lang: string | undefined,
): Promise<User> {
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

export async function setVoiceResponse(
    chatId: number,
    isEnabled: boolean,
): Promise<void> {
    await pool.query(
        `
        update chats
        set send_voice = $2
        where id = $1
        `,
        [chatId, isEnabled],
    )
}

export async function setMasterPrompt(
    chatId: number,
    masterPrompt: string | null,
): Promise<void> {
    await pool.query(
        `
        update chats
        set master_prompt = $2
        where id = $1
        `,
        [chatId, masterPrompt],
    )
}

export async function upsertChat(
    id: number,
    type: string,
    uname: string | undefined,
): Promise<Chat> {
    return await one(
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

export async function changeVoice(
    chatId: number,
    voiceCode: string,
): Promise<Chat> {
    return await one(
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

export async function setTtsElapsed(
    promptId: number,
    elapsed: number,
): Promise<void> {
    assert(Number.isInteger(promptId))
    assert(Number.isInteger(elapsed))
    await pool.query(
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
    ttsElapsed,
}: {
    userId: number
    chatId: number
    prompt: string
    messageId: number
    answer: string
    promptTokens: number
    answerTokens: number
    gptElapsed: number | undefined
    ttsElapsed: number | undefined
}): Promise<Prompt> {
    return await one(
        pool,
        `
    insert into prompts (chat_id, user_id, prompt, message_id, answer, prompt_tokens, answer_tokens, gpt_elapsed, tts_elapsed)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            ttsElapsed,
        ],
    )
}

// `model` should be listed: https://platform.openai.com/docs/models/model-endpoint-compatibility
export async function setModel(
    chatId: number,
    model: 'gpt-3.5-turbo' | 'gpt-4',
): Promise<void> {
    await pool.query(
        `
    update chats
    set model = $2
    where id = $1
    `,
        [chatId, model],
    )
}

export async function setTemperature(
    chatId: number,
    temperature: number,
): Promise<void> {
    assert(
        temperature >= 0 && temperature <= 1.0,
        'temp must be in range [0, 1]',
    )
    await pool.query(
        `
    update chats
    set temperature = $2
    where id = $1
    `,
        [chatId, temperature],
    )
}

// export async function listHistory(userId: number, chatId: number) {
export async function listHistory(
    chatId: number,
    systemPrompt: string,
    userPrompt: string,
): Promise<Message[]> {
    const { rows }: { rows: Prompt[] } = await pool.query(
        `
        select * from prompts
        where chat_id = $1
          and length(prompt) > 0
        order by id desc
        limit 20
    `,
        [chatId],
    )

    // The token budget of 4096 is a sum of historical message tokens + user prompt + ChatGPT answer.
    // This means that the following code tries to load 4096-512 tokens of historical messages
    // and leaves 512 tokens between the user prompt (usually short in the Telegram chat setting) and
    // ChatGPT's answer.
    let budget =
        4096 - 512 - countTokens(systemPrompt) - countTokens(userPrompt)

    // Reminder: The messages will get reversed at the end.
    const output: Message[] = [{ role: 'user', content: userPrompt }]

    for (const row of rows) {
        if (budget - row.answer_tokens < 0) {
            break
        }
        // assistant first because we're going to reverse it
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

    output.push({
        role: 'system',
        content: systemPrompt,
    })

    return output.reverse()
}

// =========================================================
// DB types
// =========================================================

export interface Prompt {
    id: number
    prompt: string
    prompt_tokens: number
    answer: string
    answer_tokens: number
}

export interface Message {
    role: 'system' | 'assistant' | 'user'
    content: string
}

export interface User {
    id: number
    uname: string
    lang: string | undefined
}

export interface Chat {
    id: number
    type: 'private' | 'group' | 'supergroup' | 'channel'
    model: 'gpt-3.5-turbo' | 'gpt-4'
    voice: string | undefined
    master_prompt: string | undefined
    send_voice: boolean
    temperature: number
}
