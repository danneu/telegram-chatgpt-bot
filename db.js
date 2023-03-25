const pg = require('pg')
const { DATABASE_URL } = require('./config')
const assert = require('assert')

// Tell pg to parse numeric column as float.
require('pg').types.setTypeParser(1700, (val) => Number.parseFloat(val))

const pool = new pg.Pool({
    connectionString: DATABASE_URL,
})

async function one(pool, stmt, params) {
    const result = await pool.query(stmt, params)
    return result.rows[0]
}

module.exports.clearPrompts = async function (userId) {
    return pool.query(
        `
    delete from prompts
    where user_id = $1
    `,
        [userId],
    )
}

module.exports.upsertUser = async function (id, uname, lang) {
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

module.exports.setVoiceResponse = async function (chatId, isEnabled) {
    return pool.query(
        `
        update chats
        set send_voice = $2
        where id = $1
        `,
        [chatId, isEnabled],
    )
}

module.exports.upsertChat = async function (id, type, uname) {
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

module.exports.changeVoice = async function (chatId, voiceCode) {
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

module.exports.setTtsElapsed = async function (promptId, elapsed) {
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

module.exports.insertAnswer = async function ({
    userId,
    chatId,
    prompt,
    messageId,
    answer,
    promptTokens,
    answerTokens,
}) {
    return one(
        pool,
        `
    insert into prompts (chat_id, user_id, prompt, message_id, answer, prompt_tokens, answer_tokens)
    values ($1, $2, $3, $4, $5, $6, $7)
    returning *
`,
        [chatId, userId, prompt, messageId, answer, promptTokens, answerTokens],
    )
}

module.exports.setTemperature = async function (chatId, temperature) {
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

module.exports.listHistory = async function (userId, chatId) {
    const { rows } = await pool.query(
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
    let output = []
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
