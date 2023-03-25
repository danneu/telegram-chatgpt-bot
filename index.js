// first party
const openai = require('./openai')
const db = require('./db')
const tts = require('./tts')
const config = require('./config')
const TelegramClient = require('./telegram')
const { countTokens } = require('./tokenizer')
const prettyVoice = require('./pretty-voice')
// third party
const ffmpeg = require('fluent-ffmpeg')
// server
const Koa = require('koa')
const Router = require('@koa/router')
const logger = require('koa-logger')
const bodyParser = require('koa-bodyparser')
// Node
const assert = require('assert')
const { createWriteStream, createReadStream } = require('fs')
const { unlink, readdir } = require('fs/promises')
const { Readable } = require('stream')
const { finished } = require('stream/promises')

const telegram = new TelegramClient(config.TELEGRAM_BOT_TOKEN)

const PER_USER_CONCURRENCY = 3
// Mapping of user_id to the number of requests they have in flight.
const inflights = {}

async function cleanTmpDirectory() {
    const { join } = require('path')
    let dir = 'tmp/answer-voice'
    for (const file of await readdir(dir)) {
        if (file === '.gitkeep') continue
        await unlink(join(dir, file))
    }
    dir = 'tmp/user-voice'
    for (const file of await readdir(dir)) {
        if (file === '.gitkeep') continue
        await unlink(join(dir, file))
    }
}

// TODO: Should probably mkdir -p tmp/{answer-voice,user-voice}
async function initializeBot() {
    await cleanTmpDirectory()

    // https://core.telegram.org/bots/api#authorizing-your-bot
    // Check if webhook: https://core.telegram.org/bots/api#getwebhookinfo
    const webhookInfo = await telegram
        .request('getWebhookInfo')
        .then((x) => x.json())

    if (!webhookInfo.url) {
        await telegram.request('setWebhook', {
            url: config.WEBHOOK_URL,
            // allowed_updates: ['message'],
        })
    }

    await telegram.request('setMyCommands', {
        commands: JSON.stringify([
            {
                command: 'setvoice',
                description: 'set bot language',
            },
            {
                command: 'voiceoff',
                description: 'disable voice responses',
            },
            {
                command: 'voiceon',
                description: 'enable voice responses',
            },
            {
                command: 'settemp',
                description: 'set temperature (randomness)',
            },
            { command: 'info', description: 'show bot settings' },
            {
                command: 'clear',
                description: 'reset chat context',
            },
        ]),
    })
}

////////////////////////////////////////////////////////////
// SERVER
////////////////////////////////////////////////////////////

const app = new Koa()
app.use(logger())
app.use(bodyParser())
const router = new Router()

router.get('/', async (ctx) => {
    ctx.body = 'Bot is online'
})

// Returns string
async function fetchOggAndConvertToMp3(oggUrl, fileId) {
    const localOggPath = require('path').join(
        __dirname,
        'tmp',
        'user-voice',
        fileId + '.ogg',
    )
    const localMp3Path = require('path').join(
        __dirname,
        'tmp',
        'user-voice',
        fileId + '.mp3',
    )

    const response = await fetch(oggUrl)
    if (response.status !== 200) {
        throw new Error('TODO: Handle this error')
    }
    const writableSteam = createWriteStream(localOggPath)
    await finished(Readable.fromWeb(response.body).pipe(writableSteam))
    console.log(`wrote ${localOggPath}`)

    // Convert .ogg -> .mp3
    await new Promise((resolve, reject) => {
        const start = Date.now()
        ffmpeg()
            .input(localOggPath)
            .save(localMp3Path)
            .on('error', reject)
            .on('end', () => {
                console.log(`ogg -> mp3 time: ${Date.now() - start}ms`)
                resolve()
            })
    })
    console.log(`converted to mp3: ${localMp3Path}`)

    // Send .mp3 for transcription
    const result = await openai.transcribeAudio(createReadStream(localMp3Path))

    // Cleanup tmp files
    unlink(localMp3Path).catch(console.error)
    unlink(localOggPath).catch(console.error)

    return result.data.text
}

// voice:English --> show the countries
// voice:English:US --> show the US voices
// voice:English:US:Jenny -> pick the Jenny voice
//
//
// Note: Always have an even number of voices per country.
const VOICE_MENU = {
    English: {
        Australia: {
            Annette: 'en-AU-AnnetteNeural',
            Darren: 'en-AU-DarrenNeural',
        },
        UK: {
            Abbi: 'en-GB-AbbiNeural',
            Alfie: 'en-GB-AlfieNeural',
        },
        US: {
            Jenny: 'en-US-JennyNeural',
            Brandon: 'en-US-BrandonNeural',
        },
    },
    Spanish: {
        US: {
            Paloma: 'es-US-PalomaNeural',
            Alonso: 'es-US-AlonsoNeural',
        },
        Spain: {
            Abril: 'es-ES-AbrilNeural',
            Alvaro: 'es-ES-AlvaroNeural',
        },
        Mexico: {
            Beatriz: 'es-MX-BeatrizNeural',
            Candela: 'es-MX-CandelaNeural',
            Cecilio: 'es-MX-CecilioNeural',
            Gerardo: 'es-MX-GerardoNeural',
        },
        Argentina: {
            Elena: 'es-AR-ElenaNeural',
            Tomas: 'es-AR-TomasNeural',
        },
        Colombia: {
            Salome: 'es-CO-SalomeNeural',
            Gonzalo: 'es-CO-GonzaloNeural',
        },
    },
}

function chunksOf(chunkSize, arr) {
    const res = []
    for (let i = 0; i < arr.length; i += chunkSize) {
        const chunk = arr.slice(i, i + chunkSize)
        res.push(chunk)
    }
    return res
}

async function handleCallbackQuery(body) {
    // https://core.telegram.org/bots/api#inlinekeyboardmarkup
    const chatId = body.callback_query.from.id
    const messageId = body.callback_query.message.message_id
    const callbackQueryId = body.callback_query.id
    const callbackData = body.callback_query.data

    if (callbackData.startsWith('temp:')) {
        const temperature = Number.parseFloat(callbackData.split(':')[1])
        if (temperature < 0) temperature = 0
        if (temperature > 1) temperature = 1
        console.log('setting temp', temperature)
        await db.setTemperature(chatId, temperature)
        // https://core.telegram.org/bots/api#answercallbackquery
        await telegram.sendMessage(
            chatId,
            `🌡️ Temperature changed to ${temperature.toFixed(1)}`,
        )
        // await telegram.request('answerCallbackQuery', {
        //     callback_query_id: callbackQueryId,
        //     text: `✅ Temperature changed to ${temperature.toFixed(1)}`,
        // })
        // await telegram.deleteMessage(chatId, messageId)
        return
    }

    // voice:English --> show the countries
    // voice:English:US --> show the US voices
    // voice:English:US:Jenny -> pick the Jenny voice
    const segments = callbackData.split(':')
    switch (segments.length) {
        // voice --> Show the language selections
        case 1:
            {
                const langs = Object.keys(VOICE_MENU)
                const inlineKeyboard = chunksOf(2, langs).map((chunk) => {
                    return chunk.map((lang) => {
                        return {
                            text: lang,
                            callback_data: `voice:${lang}`,
                        }
                    })
                })
                await telegram.editMessageReplyMarkup(
                    chatId,
                    messageId,
                    inlineKeyboard,
                )
            }
            return
        // voice:English --> List the countries available for English
        case 2:
            {
                const countryNames = Object.keys(VOICE_MENU[segments[1]])
                const inlineKeyboard = [
                    [{ text: '⏪ Back', callback_data: 'voice' }],
                ].concat(
                    chunksOf(2, countryNames).map((chunk) => {
                        return chunk.map((countryName) => {
                            return {
                                text: countryName,
                                callback_data: `voice:${segments[1]}:${countryName}`,
                            }
                        })
                    }),
                )
                await telegram.editMessageReplyMarkup(
                    chatId,
                    messageId,
                    inlineKeyboard,
                )
            }
            return
        // voice:English:US --> List the voices available for US English
        case 3:
            {
                const inlineKeyboard = [
                    [
                        {
                            text: '⏪ Back',
                            callback_data: `voice:${segments[1]}`,
                        },
                    ],
                ].concat(
                    chunksOf(
                        2,
                        Object.entries(VOICE_MENU[segments[1]][segments[2]]),
                    ).map((chunk) => {
                        return chunk.map(([name, code]) => {
                            return {
                                text: name,
                                callback_data: `voice:${segments[1]}:${segments[2]}:${code}`,
                            }
                        })
                    }),
                )

                // Note: I originally sent editMessageReplyMarkup and editMessage at the same time,
                // the latter updating the menu message text, but there's a race condition that would
                // prevent the inline keyboard from updating, so now I don't update the message text.
                await telegram.editMessageReplyMarkup(
                    chatId,
                    messageId,
                    inlineKeyboard,
                )
            }
            return
        // voice:English:US:en-US-JennyNeural --> Pick this voice
        case 4:
            {
                const newVoice = segments[3]
                await db.changeVoice(chatId, newVoice)
                // https://core.telegram.org/bots/api#answercallbackquery
                await telegram.request('answerCallbackQuery', {
                    callback_query_id: callbackQueryId,
                    text: `✅ Voice changed to ${newVoice}`,
                })
                await telegram.deleteMessage(chatId, messageId)
            }
            return
    }
}

async function processUserMessage(user, chat, body) {
    // Reject messages from groups until they are deliberately supported.
    if (body.message.chat.type !== 'private') {
        console.log('rejecting non-private chat')
        return
    }

    const userId = body.message.from.id
    const chatId = body.message.chat.id
    const messageId = body.message.message_id
    let userText = body.message.text

    // Basic check to prevent too many in-flight requests per user.

    // Check if voice and transcribe it
    if (body.message.voice) {
        await telegram.indicateTyping(chatId)

        const remoteFileUrl = await telegram.getFileUrl(
            body.message.voice.file_id,
        )
        userText = await fetchOggAndConvertToMp3(
            remoteFileUrl,
            body.message.voice.file_id,
        )

        // Send transcription to user so they know how the bot interpreted their memo.
        await telegram.sendMessage(
            chatId,
            `(Transcription) <i>${userText}</i>`,
            messageId,
        )

        // We can send a new typing indicator since we just sent a message
        await telegram.indicateTyping(chatId)
    }

    // TODO: If added to a group and user uses menu to select /setvoice, telegram sends
    // message "/getvoice@dev_god_in_a_bot" to disambiguate between other commands, so we
    // need to handle that.

    // Check if command and short-circuit
    if (userText === '/start') {
        await telegram.indicateTyping(chatId)
        return telegram.sendMessage(
            chatId,
            `Hello! I'm an AI chat bot powered by ChatGPT. Go ahead and ask me something.\n\nI respond in English by default. Use /setvoice to use a different language.`,
        )
    } else if (userText === '/clear') {
        await telegram.indicateTyping(chatId)
        await db.clearPrompts(chatId)
        await telegram.sendMessage(chatId, 'Context cleared.', messageId)
        return
    } else if (userText === '/info') {
        await telegram.sendMessage(
            chatId,
            `
Bot info:

- Voice: ${prettyVoice(chat.voice || tts.DEFAULT_VOICE)} 
- Voice responses: ${chat.send_voice ? '🔊 On' : '🔇 Off'}
- Temperature: ${chat.temperature.toFixed(1)}
        `.trim(),
            messageId,
        )
        return
    } else if (userText === '/voiceon') {
        await Promise.all([
            telegram.indicateTyping(chatId),
            db.setVoiceResponse(chatId, true),
        ])
        await telegram.sendMessage(
            chatId,
            '🔊 Bot voice responses enabled.',
            messageId,
        )
        return
    } else if (userText === '/voiceoff') {
        await Promise.all([
            telegram.indicateTyping(chatId),
            db.setVoiceResponse(chatId, false),
        ])
        await telegram.sendMessage(
            chatId,
            '🔇 Bot voice responses disabled.',
            messageId,
        )
        return
    } else if (userText === '/temp') {
        await telegram.indicateTyping(chatId)
        await telegram.request('sendMessage', {
            chat_id: chatId,
            text: `Select temperature from less random (0.0) to more random (1.0).\n\nCurrent: ${chat.temperature.toFixed(
                1,
            )} (default: 0.8)`,
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [
                        { text: '0.0', callback_data: `temp:0.0` },
                        { text: '0.2', callback_data: 'temp:0.2' },
                        { text: '0.4', callback_data: 'temp:0.4' },
                        { text: '0.6', callback_data: 'temp:0.6' },
                        { text: '0.8', callback_data: 'temp:0.8' },
                        { text: '1.0', callback_data: 'temp:1.0' },
                    ],
                ],
            }),
        })
        return
    } else if (userText === '/setvoice') {
        await telegram.indicateTyping(chatId)
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`

        const langs = Object.keys(VOICE_MENU)
        const inlineKeyboard = chunksOf(2, langs).map((chunk) => {
            return chunk.map((lang) => {
                return {
                    text: lang,
                    callback_data: `voice:${lang}`,
                }
            })
        })
        const response = await telegram.request('sendMessage', {
            chat_id: chatId,
            text: `Select a voice/language for the bot's text-to-speech voice memos.`,
            reply_markup: JSON.stringify({
                inline_keyboard: inlineKeyboard,
            }),
        })
        console.log(
            `POST ${url} -> ${response.status} ${await response.text()}`,
        )
        return
    } else if (userText === '/voices') {
        await telegram.indicateTyping(chatId)
        await telegram.sendMessage(
            chatId,
            `Choose one of the voices on the "Text-to-speech" tab <a href="https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support?tabs=tts">here</a>. 
            
For example, <code>/voice en-US-AriaNeural</code>`,
        )
        return
    } else if (userText.startsWith('/voice ')) {
        await telegram.indicateTyping(chatId)
        const voiceCode = userText.split(/\ +/)[1]
        if (/[a-z]{2}\-[A-Z]{2}-[a-zA-Z0-0]+/.test(voiceCode)) {
            await db.changeVoice(chatId, voiceCode)
        } else {
            await telegram.sendMessage(
                chatId,
                'The voice name should look something like "en-US-AmberNeural" or "es-MX-CandelaNeural".',
            )
        }
        return
    } else if (userText.startsWith('/')) {
        // Ignore unsupported commands. They could be intended for other bots in a group chat.
        return
    }

    await telegram.indicateTyping(chatId)

    // Fetch chatgpt completion
    const history = await db.listHistory(userId, chatId)

    // const { response, elapsed: gptElapsed } = await openai.fetchChatResponse(
    //     history,
    //     userText,
    //     chat.temperature,
    // )

    // // Handle 429 Too Many Requests
    // if (response.status === 429) {
    //     await telegram.sendMessage(
    //         chatId,
    //         `❌ Bot is rate-limited by OpenAI API. Try again soon.`,
    //         messageId,
    //     )
    //     return
    // }

    const gptStart = Date.now()
    let tokens
    try {
        tokens = await openai.streamChatCompletions(
            history,
            userText,
            chat.temperature,
        )
    } catch (err) {
        // TODO: haven't tested this.
        if (err.response?.status === 429) {
            await telegram.sendMessage(
                chatId,
                `❌ Bot is rate-limited by OpenAI API. Try again soon.`,
                messageId,
            )
            return
        } else {
            throw err
        }
    }

    // As chat completion tokens come streaming in from OpenAI, this function accumulates
    // the tokens into a buffer. First it creates a new Telegram message, and every
    // 1000ms it edits that message with the latest state of the token buffer.
    //
    // I chose 1000ms because I don't want to spam the Telegram API, but it means that
    // larger chunks of text appear at a time.
    //
    // The goal here is for the user to not have to wait until the entire token stream
    // is buffered before seeing the response just like how user can watch the tokens
    // stream in on chat.openai.com/chat.
    //
    // Returns the full answer text when done and the messageId of the final message sent.
    async function streamTokensToTelegram(chatId, tokenIterator) {
        let buf = '' // Latest buffer
        let sentBuf = '' // A snapshot of the buffer that was sent so we know when it has changed.
        let prevId
        let isFinished = false
        // https://en.wikipedia.org/wiki/Block_Elements
        const cursor = '▍'

        // Call after prevId is set.
        async function editLoop() {
            if (isFinished) {
                return
            }
            if (sentBuf !== buf) {
                sentBuf = buf
                await telegram.editMessageText(chatId, prevId, buf + cursor)
            }
            setTimeout(editLoop, 1000)
        }

        for await (const token of tokenIterator) {
            buf += token
            if (!prevId) {
                prevId = await telegram
                    .sendMessage(chatId, cursor, messageId)
                    .then((res) => res.json())
                    .then((body) => body.result.message_id)

                // Start the edit loop after we have our first message so that at least 1000ms of tokens have
                // accumulated.
                setTimeout(editLoop, 1000)

                // Send one more typing indicator that should cover the following edits.
                // Too bad there's no cancelChatAction Telegram API method since the indicator
                // might play for too long.
                await telegram.indicateTyping(chatId)
            }
        }

        isFinished = true // Stop the send loop from continuing.

        // One final send, also removes the cursor.
        await telegram.editMessageText(chatId, prevId, buf)

        return {
            answer: buf,
            messageId: prevId,
        }
    }

    const { answer, messageId: answerMessageId } = await streamTokensToTelegram(
        chatId,
        tokens,
    )
    const gptElapsed = Date.now() - gptStart
    const promptTokens = countTokens(userText)
    const prompt = await db.insertAnswer({
        userId,
        chatId,
        prompt: userText,
        promptTokens,
        messageId: answerMessageId,
        answer,
        answerTokens: countTokens(answer),
        gptElapsed,
    })

    // Send trailing voice memo.
    await telegram.indicateTyping(chatId)
    if (chat.send_voice) {
        // Generate answer voice transcription
        const {
            path: localAnswerVoicePath,
            byteLength,
            elapsed,
        } = await tts.synthesize(body.update_id, prompt.answer, chat.voice)

        await Promise.all([
            db.setTtsElapsed(prompt.id, elapsed),
            telegram.sendVoice(
                chatId,
                answerMessageId,
                '',
                localAnswerVoicePath,
                byteLength,
            ),
        ])
        unlink(localAnswerVoicePath).catch((err) => {
            console.error(
                `failed to delete voice at path "${localAnswerVoicePath}": ` +
                    err,
            )
        })
    }
}

async function processWebhookBody(body) {
    // First check if callback query
    if (body.callback_query) {
        await handleCallbackQuery(body)
        return
    }

    // FIXME: Else, assume it's message query for now (sloppy)
    assert(body.message, 'update should be a message type at this point')

    // The person sending the message
    const user = await db.upsertUser(
        body.message.from.id,
        body.message.from.username,
        body.message.from.language_code,
    )
    // The chat in which the user sent the message
    const chat = await db.upsertChat(
        body.message.chat.id,
        body.message.chat.type,
        body.message.chat.username,
    )

    // const session = { user, chat }
    console.log({ user, chat })

    if ((inflights[user.id] || 0) >= PER_USER_CONCURRENCY) {
        telegram.sendMessage(
            chat.id,
            '❌ You are sending me too many simulataneous messages.',
            body.message.message_id,
        )
        return
    } else {
        inflights[user.id] = (inflights[user.id] || 0) + 1
    }

    return processUserMessage(user, chat, body).finally(() => {
        if (inflights[user.id] <= 1) {
            delete inflights[user.id]
        } else {
            inflights[user.id] -= 1
        }
    })
}

// HACK
function getChatId(payload) {
    return (
        payload.message?.chat?.id || payload.callback_query?.message?.chat?.id
    )
}

// HACK
function getMessageId(payload) {
    return (
        payload.message?.message_id ||
        payload.callback_query?.message?.message_id
    )
}

router.post('/telegram', async (ctx) => {
    const { body } = ctx.request
    console.log(`received webhook event. body: `, JSON.stringify(body, null, 2))
    ctx.body = 204

    // TODO: Do the rest after response is sent.
    processWebhookBody(body).catch((err) => {
        const chatId = getChatId(body)
        const messageId = getMessageId(body)
        console.error(err)
        telegram.sendMessage(
            chatId,
            '❌ Something went wrong and the bot could not respond to your message. Try again soon?',
            messageId,
        )
    })
})

app.use(router.middleware())

initializeBot()
    .then(() => {
        console.log('bot initialized')
        app.listen(config.PORT, () => {
            console.log(`listening on localhost:${config.PORT}`)
        })
    })
    .catch(console.error)
