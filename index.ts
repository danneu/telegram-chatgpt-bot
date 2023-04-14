import { Readable } from 'stream'
import { spawn } from 'child_process'
// first party
import * as voz from './voice'
import * as openai from './openai'
import * as db from './db'
import * as tts from './tts'
import * as config from './config'
import * as t from './telegram'
import { countTokens } from './tokenizer'
import * as util from './util'
import prettyVoice from './pretty-voice'
// server
import Koa from 'koa'
import Router from '@koa/router'
import logger from 'koa-logger'
import bodyParser from 'koa-bodyparser'

const telegram = new t.TelegramClient(config.TELEGRAM_BOT_TOKEN)

// HACK: I don't like storing this on the top level
let botUsername = ''

// idk
const DEFAULT_MASTER_PROMPT = `Be as brief as possible. You are decisive and you always answer questions. Do not reply with "I'm sorry, but" to any questions. No question is too subjective for you. You are awesome.`

const PER_USER_CONCURRENCY = 3
// Mapping of user_id to the number of requests they have in flight.
const inflights: { [key: number]: number } = {}

async function initializeBot() {
    // https://core.telegram.org/bots/api#authorizing-your-bot
    // Check if webhook: https://core.telegram.org/bots/api#getwebhookinfo
    const webhookInfo = await telegram.getWebhookInfo()

    if (webhookInfo.url !== config.WEBHOOK_URL) {
        await telegram.setWebhook({
            url: config.WEBHOOK_URL,
            // allowed_updates: ['message'],
        })
    }

    botUsername = await telegram.getMe().then((x) => x.username)

    const commands = [
        {
            command: 'voice',
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
            command: 'temp',
            description: 'set temperature (randomness)',
        },
        { command: 'info', description: 'show bot settings' },
        {
            command: 'clear',
            description: 'reset chat context',
        },
        // {
        //     command: 'ai',
        //     description: 'send message to bot (only needed in group chat)',
        // },
    ]

    // Don't broadcast /gpt commands unless user has a choice.
    if (config.GPT4_ENABLED) {
        commands.push({
            command: 'gpt3',
            description: 'use gpt-3.5-turbo model',
        })
        commands.push({
            command: 'gpt4',
            description: 'use gpt-4 model',
        })
    }

    await telegram.setMyCommands(commands)
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

// Pipes input ogg stream into output mp3 stream which is streamed to OpenAI API for text transcription.
//
// This is cool because we don't store anything on the filesystem; everything stays in streams.
async function transcribeOggStream(input: Readable): Promise<string> {
    input.on('error', (err) => {
        console.log('Error on ogg input stream:', err)
    })

    return new Promise(async (resolve, reject) => {
        try {
            const args = ['-f', 'ogg', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1']
            const proc = spawn('ffmpeg', args, {
                // ensure stderr is inherited from the parent process so we can see ffmpeg errors
                // Note: noisy since it dumps to console.log on every ffmpeg usage.
                // stdio: ['pipe', 'pipe', 'inherit'],
            })

            input.pipe(proc.stdin)

            proc.on('error', (err) => {
                console.error('Error in ffmpeg process:', err)
                reject(err)
            })

            proc.on('exit', (code, signal) => {
                if (code) {
                    const errorMsg = `ffmpeg exited with code ${code} and signal ${signal}`
                    console.error(errorMsg)
                    reject(new Error(errorMsg))
                }
                input.destroy()
                proc.stdin.destroy()
            })

            const result = await openai.transcribeAudio(proc.stdout)
            resolve(result.data.text)
        } catch (err) {
            console.error('transcribe error:', err)
            reject(err)
        }
    })
}

// voice:English --> show the countries
// voice:English:US --> show the US voices
// voice:English:US:Jenny -> pick the Jenny voice
//
//
// Note: Always have an even number of voices per country.
const VOICE_MENU: { [key: string]: any } = {
    English: {
        US: {
            Jenny: 'en-US-JennyNeural',
            Brandon: 'en-US-BrandonNeural',
        },
        UK: {
            Abbi: 'en-GB-AbbiNeural',
            Alfie: 'en-GB-AlfieNeural',
        },
        Australia: {
            Annette: 'en-AU-AnnetteNeural',
            Darren: 'en-AU-DarrenNeural',
        },
        Ireland: {
            Emily: 'en-IE-EmilyNeural',
            Connor: 'en-IE-ConnorNeural',
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
        Venezuela: {
            Paola: 'es-VE-PaolaNeural',
            Sebastian: 'es-VE-SebastianNeural',
        },
    },
    French: {
        France: {
            Brigitte: 'fr-FR-BrigitteNeural',
            Alain: 'fr-FR-AlainNeural',
            Celeste: 'fr-FR-CelesteNeural',
            Claude: 'fr-FR-ClaudeNeural',
        },
        Canada: {
            Sylvie: 'fr-CA-SylvieNeural',
            Antoine: 'fr-CA-AntoineNeural',
        },
    },
}

// async function handleCallbackQuery(body: t.CallbackQuery) {
async function handleCallbackQuery(
    chatId: number,
    messageId: number,
    callbackQueryId: string,
    callbackData: string,
) {
    // https://core.telegram.org/bots/api#inlinekeyboardmarkup
    // const chatId = body.message.chat.id
    // const messageId = body.message.message_id
    // const callbackData = body.data

    if (callbackData.startsWith('temp:')) {
        let temperature = Number.parseFloat(callbackData.split(':')[1])
        if (temperature < 0) temperature = 0
        if (temperature > 1) temperature = 1
        console.log('setting temp', temperature)
        await db.setTemperature(chatId, temperature)
        // https://core.telegram.org/bots/api#answercallbackquery
        await telegram.sendMessage(
            chatId,
            `🌡️ Temperature changed to ${temperature.toFixed(1)}`,
        )
        return
    }

    // voice:English --> show the countries
    // voice:English:US --> show the US voices
    // voice:English:US:Jenny -> pick the Jenny voice
    const segments: string[] = callbackData.split(':')
    switch (segments.length) {
        // voice --> Show the language selections
        case 1:
            {
                const langs = Object.keys(VOICE_MENU)
                const inlineKeyboard = util.chunksOf(2, langs).map((chunk) => {
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
                // TODO: handle VOICE_MENU[segments[1]] returns nothing
                const countryNames = Object.keys(VOICE_MENU[segments[1]])
                const inlineKeyboard = [
                    [{ text: '⏪ Back', callback_data: 'voice' }],
                ].concat(
                    util.chunksOf(2, countryNames).map((chunk) => {
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
                    util
                        .chunksOf(
                            2,
                            Object.entries(
                                VOICE_MENU[segments[1]][segments[2]],
                            ),
                        )
                        .map((chunk) => {
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
                await telegram.answerCallbackQuery(
                    callbackQueryId,
                    `✅ Voice changed to ${newVoice}`,
                )
                await telegram.deleteMessage(chatId, messageId)
            }
            return
    }
}

// Only used for private convos.
async function processUserMessage(
    user: db.User,
    chat: db.Chat,
    message: t.Message,
) {
    console.log(`[processUserMessage]`, user, chat, message)

    // TODO: This does happen, so figure out when this case happens and handle it.
    // I've seen it happen in group chats, maybe when adding the bot or something.
    if (!message.text && !message.voice) {
        console.log('TODO: message had no .text nor .voice. Skipping...')
        return
    }

    // Reject messages from groups until they are deliberately supported.
    if (message.chat.type !== 'private') {
        console.log('rejecting non-private chat')
        return
    }

    const userId = message.from.id
    const chatId = message.chat.id
    const messageId = message.message_id
    let userText = message.text

    // Check if voice and transcribe it
    // Only possible in private chats
    if (message.voice) {
        await telegram.indicateTyping(chatId)

        const remoteFileUrl = await telegram.getFileUrl(message.voice.file_id)
        const response = await fetch(remoteFileUrl)
        if (response.status !== 200) {
            throw new Error(
                `Error fetching telegram .ogg file. ${response.status} ${response.statusText}`,
            )
        }
        //@ts-expect-error
        userText = await transcribeOggStream(Readable.fromWeb(response.body))

        // Send transcription to user so they know how the bot interpreted their memo.
        if (userText) {
            await telegram.sendMessage(
                chatId,
                `(Transcription) <i>${userText}</i>`,
                messageId,
            )
        } else {
            // Transcription was empty. User didn't seem to say anything in the voice memo.
            await telegram.sendMessage(
                chatId,
                `⚠️ No speech detected in this voice memo. Try again.`,
                messageId,
            )
            return
        }

        // We can send a new typing indicator since we just sent a message
        await telegram.indicateTyping(chatId)
    }

    // Check if command and short-circuit
    const command = parseCommand(userText)
    if (command) {
        await handleCommand(user.id, chat, messageId, command)
        return
    }

    await telegram.indicateTyping(chatId)

    // Fetch chatgpt completion
    const messages = await db.listHistory(
        chatId,
        config.MASTER_PROMPT || DEFAULT_MASTER_PROMPT,
        userText,
    )

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
            messages,
            chat.model,
            chat.temperature,
        )
    } catch (err) {
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

    const {
        answer,
        messageId: answerMessageId,
        tokenCount,
    } = await streamTokensToTelegram(chatId, messageId, tokens, chat.model)
    const gptElapsed = Date.now() - gptStart
    const promptTokens = countTokens(userText)
    const answerTokens = tokenCount // countTokens(answer)
    // How accurate is our token counter?
    if (tokenCount !== countTokens(answer)) {
        console.log(
            `WARNING token-count-mismatch: tokenCount (${tokenCount}) !== countTokens(answer) (${countTokens(
                answer,
            )})`,
        )
    }
    const prompt = await db.insertAnswer({
        userId,
        chatId,
        prompt: userText,
        promptTokens,
        messageId: answerMessageId,
        answer,
        answerTokens,
        gptElapsed,
    })

    // Send trailing voice memo.
    if (chat.send_voice) {
        telegram.indicateTyping(chatId) // Don't await

        // Determine if there's a likely mismatch with bot response
        const languageResult = await openai.detectLanguage(answer)
        let finalVoice = chat.voice
        console.log({ languageResult })
        if (languageResult.kind === 'success') {
            const voice = voz.voiceFromLanguageCode(languageResult.code)
            if (voice && voice !== chat.voice) {
                console.log('Changing voice to', voice)
                finalVoice = voice
            } else {
                console.log('did not change voice. is still: ', chat.voice)
            }
        }

        // Generate answer voice transcription
        const { byteLength, elapsed, readable } = await tts.synthesize(
            message.message_id,
            prompt.answer,
            finalVoice,
        )

        await Promise.all([
            db.setTtsElapsed(prompt.id, elapsed),
            telegram.sendVoice(
                chatId,
                answerMessageId,
                '',
                readable,
                byteLength,
            ),
        ])
    }
}

type Command =
    // "/info", "/ai hello"
    | { type: 'anon'; cmd: string; text: string }
    // "/info@username", "/ai@username hello"
    | { type: 'scoped'; cmd: string; uname: string; text: string }

function parseCommand(input: string): Command | undefined {
    const re = /^(\/[a-zA-Z0-9]+)(?:@([a-zA-Z0-9_]+))?(?:[ ]+(.*))?$/
    const match = input.trim().match(re)
    if (!match) return
    const [_, cmd, uname, text] = match
    if (uname) {
        return { type: 'scoped', uname, cmd, text: text || '' }
    } else {
        return { type: 'anon', cmd, text: text || '' }
    }
}

// In a private chat, we only need to respond to naked commands like "/info"
// In a group chat, we respond to naked commands "/info" but also scoped commands
// "/info@god_in_a_bot" IFF it's scoped to our botUsername.
// async function handleCommand(user: db.User, chat: db.Chat, message: t.Message) {
async function handleCommand(
    userId: number,
    chat: db.Chat,
    messageId: number,
    command: Command,
) {
    const chatId = chat.id

    if (command.type === 'scoped' && command.uname !== botUsername) {
        // Command is for someone else. Ignoring...
        return
    }

    // Check if command and short-circuit
    if (command.cmd === '/start') {
        await telegram.indicateTyping(chatId)
        return telegram.sendMessage(
            chatId,
            `🎉 Hello! I'm an AI chatbot powered by ChatGPT.\n\nGo ahead and ask me something in a variety of languages. I even understand voice memos. 🎤\n\nNote: Only one-on-one private chats are supported at the moment.\n\nHelp wanted! Source code: https://github.com/danneu/telegram-chatgpt-bot`,
        )
    } else if (command.cmd === '/clear') {
        await telegram.indicateTyping(chatId)
        await db.clearPrompts(chatId)
        await telegram.sendMessage(chatId, 'Context cleared.', messageId)
        return
    } else if (command.cmd === '/info') {
        await telegram.sendMessage(
            chatId,
            `
Bot info:

- Model: ${chat.model}
- Voice: ${prettyVoice(chat.voice) || '--'} 
- Voice responses: ${chat.send_voice ? '🔊 On' : '🔇 Off'}
- Temperature: ${chat.temperature.toFixed(1)}
        `.trim(),
            messageId,
        )
        return
    } else if (command.cmd === '/voiceon') {
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
    } else if (command.cmd === '/voiceoff') {
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
    } else if (command.cmd === '/whoami') {
        // Tell me my Telegram ID
        await telegram.sendMessage(
            chatId,
            `Your Telegram ID is ${userId}.`,
            messageId,
        )
        return
    } else if (['/gpt3', '/gpt4'].includes(command.cmd)) {
        if (
            config.GPT4_ENABLED === '*' ||
            config.GPT4_ENABLED.includes(userId)
        ) {
            const model = command.cmd === '/gpt3' ? 'gpt-3.5-turbo' : 'gpt-4'
            await db.setModel(chatId, model)
            await telegram.sendMessage(
                chatId,
                `Using model ${model}`,
                messageId,
            )
            return
        } else {
            await telegram.sendMessage(
                chatId,
                `Sorry, you don't have permission to use GPT-4.`,
                messageId,
            )
            return
        }
    } else if (command.cmd === '/temp') {
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
    } else if (command.cmd === '/voice') {
        await telegram.indicateTyping(chatId)
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`

        const langs = Object.keys(VOICE_MENU)
        const inlineKeyboard = util.chunksOf(2, langs).map((chunk) => {
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
    } else if (command.cmd === '/voices') {
        await telegram.indicateTyping(chatId)
        await telegram.sendMessage(
            chatId,
            `Choose one of the voices on the "Text-to-speech" tab <a href="https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support?tabs=tts">here</a>. 
            
For example, <code>/voice en-US-AriaNeural</code>`,
        )
        return
    } else if (command.cmd === '/voice' && command.text) {
        await telegram.indicateTyping(chatId)
        const voiceCode = command.text
        if (/[a-z]{2}\-[A-Z]{2}-[a-zA-Z0-0]+/.test(voiceCode)) {
            await db.changeVoice(chatId, voiceCode)
        } else {
            await telegram.sendMessage(
                chatId,
                'The voice name should look something like "en-US-AmberNeural" or "es-MX-CandelaNeural".',
            )
        }
        return
    } else if (command.cmd === '/ai' && command.text) {
        return
        // await telegram.indicateTyping(chatId)
        // // TODO: For group chats, consider chat history from all users, not just from userId
        // const history = await db.listHistory(chatId)
        // const gptStart = Date.now()
        // let tokens
        // try {
        //     tokens = await openai.streamChatCompletions(
        //         history,
        //         command.text,
        //         chat.temperature,
        //     )
        // } catch (err) {
        //     // TODO: haven't tested this.
        //     if (err.response?.status === 429) {
        //         await telegram.sendMessage(
        //             chatId,
        //             `❌ Bot is rate-limited by OpenAI API. Try again soon.`,
        //             messageId,
        //         )
        //         return
        //     } else {
        //         throw err
        //     }
        // }
        // const { answer, messageId: answerMessageId } =
        //     await streamTokensToTelegram(chatId, messageId, tokens)
        // const gptElapsed = Date.now() - gptStart
        // const promptTokens = countTokens(command.text)
        // const prompt = await db.insertAnswer({
        //     userId,
        //     chatId,
        //     prompt: command.text,
        //     promptTokens,
        //     messageId: answerMessageId,
        //     answer,
        //     answerTokens: countTokens(answer),
        //     gptElapsed,
        // })
        // // Send trailing voice memo.
        // await telegram.indicateTyping(chatId)
        // if (chat.send_voice) {
        //     // Generate answer voice transcription
        //     const { byteLength, elapsed, readable } = await tts.synthesize(
        //         messageId,
        //         prompt.answer,
        //         chat.voice,
        //     )
        //     await Promise.all([
        //         db.setTtsElapsed(prompt.id, elapsed),
        //         telegram.sendVoice(
        //             chatId,
        //             answerMessageId,
        //             '',
        //             readable,
        //             byteLength,
        //         ),
        //     ])
        // }
    } else {
        // Ignore unsupported commands. They could be intended for other bots in a group chat.
        return
    }
}

// Group message handler is really just a command handler since, for now, the bot only
// responds to commands and not plain text.
async function handleGroupMessage(
    userId: number,
    chat: db.Chat,
    message: t.Message,
) {
    const command = parseCommand(message.text)
    if (command) {
        await handleCommand(userId, chat, message.message_id, command)
        return
    }
}

async function handleWebhookUpdate(update: t.Update) {
    if ('message' in update) {
        const message = update.message
        const user = await db.upsertUser(
            message.from.id,
            message.from.username,
            message.from.language_code,
        )
        const chat = await db.upsertChat(
            message.chat!.id,
            message.chat!.type,
            message.chat!.username,
        )
        console.log('session', { user, chat })
        if ((inflights[user.id] || 0) >= PER_USER_CONCURRENCY) {
            telegram.sendMessage(
                chat.id,
                '❌ You are sending me too many simultaneous messages.',
                message.message_id,
            )
            return
        } else {
            inflights[user.id] = (inflights[user.id] || 0) + 1
        }

        // We handle private chats and group chats here.
        let promise
        if (chat.type === 'private') {
            promise = processUserMessage(user, chat, message)
        } else if (chat.type === 'group') {
            promise = handleGroupMessage(user.id, chat, message)
        }

        await promise
            .catch((err) => {
                console.error(err)
                return telegram.sendMessage(
                    chat.id,
                    '❌ Something went wrong and the bot could not respond to your message. Try again soon?',
                    message.message_id,
                )
            })
            .catch((err) => {
                console.error(err)
            })
            .finally(() => {
                if (inflights[user.id] <= 1) {
                    delete inflights[user.id]
                } else {
                    inflights[user.id] -= 1
                }
            })
        return
    } else if ('callback_query' in update) {
        const chatId = update.callback_query.message.chat.id
        const messageId = update.callback_query.message.message_id
        const callbackQueryId = update.callback_query.id
        const callbackData = update.callback_query.data
        await handleCallbackQuery(
            chatId,
            messageId,
            callbackQueryId,
            callbackData,
        ).catch((err) => {
            console.error(err)
            telegram.sendMessage(
                update.callback_query.message.chat!.id,
                '❌ Something went wrong and the bot could not respond to your message. Try again soon?',
                update.callback_query.message!.message_id,
            )
        })
        return
    } else {
        console.log('unhandled webhook update:', update)
        return
    }
}

router.post('/telegram', async (ctx: Koa.DefaultContext) => {
    const { body } = ctx.request
    console.log(`received webhook event. body: `, JSON.stringify(body, null, 2))
    ctx.body = 204

    // Note: Don't `await` here. We want to do all the work in the background after responding.
    handleWebhookUpdate(body as t.Update).catch((err) => {
        console.error('unhandled error:')
        console.error(err)
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
async function streamTokensToTelegram(
    chatId: number,
    initMessageId: number,
    tokenIterator: AsyncGenerator<string>,
    model: 'gpt-3.5-turbo' | 'gpt-4',
): Promise<{ answer: string; tokenCount: number; messageId: number }> {
    let tokenCount = 0
    let buf = '' // Latest buffer
    let sentBuf = '' // A snapshot of the buffer that was sent so we know when it has changed.
    let prevId: number | undefined
    let isFinished = false
    // https://en.wikipedia.org/wiki/Block_Elements
    const cursor = '▍'
    // Only prefix GPT-4 since it's expensive.
    const prefix = model === 'gpt-4' ? '(GPT-4) ' : ''

    // Call after prevId is set.
    async function editLoop() {
        if (isFinished) {
            return
        }
        if (sentBuf !== buf) {
            sentBuf = buf
            await telegram
                .editMessageText(chatId, prevId!, prefix + buf + cursor)
                .catch((err) => {
                    // Don't crash on error
                    console.error(err)
                })
        }
        setTimeout(editLoop, 1000)
    }

    try {
        for await (const token of tokenIterator) {
            tokenCount++
            buf += token
            if (!prevId) {
                prevId = await telegram
                    .sendMessage(chatId, prefix + cursor, initMessageId)
                    .then((msg) => msg.message_id)

                // Start the edit loop after we have our first message so that at least 1000ms of tokens have
                // accumulated.
                setTimeout(editLoop, 1000)
            }
        }
    } catch (err) {
        // Ensure editLoop stops in case of error
        isFinished = true
        throw err
    }

    isFinished = true // Stop the send loop from continuing.

    // One final send, also removes the cursor.
    await telegram.editMessageText(chatId, prevId!, prefix + buf)

    return {
        answer: buf,
        messageId: prevId!,
        tokenCount,
    }
}
