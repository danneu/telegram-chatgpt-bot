import fs from 'fs'
import * as config from './config'

// A minimal Telegram bot client that implements only the methods and options
// that I need.

export class TelegramClient {
    readonly token: string

    constructor(token: string) {
        this.token = token
    }

    // TODO: make private
    async request(method: string, params: { [key: string]: any } = {}) {
        const url = `https://api.telegram.org/bot${this.token}/${method}`

        console.log(`makeTelegramRequest`, { method, url, params })

        // SLOPPY: Come up with deliberate error handling.
        let response
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(params, null, 2),
            })
        } catch (err: any) {
            err.response = response
            throw err
        }

        if (response.status !== 200) {
            const err = new Error('Telegram API non-200 response')
            // err.response = response
            const body = await response.json()

            console.error(
                `Non-200 Telegram API response from ${method} ${url} ${JSON.stringify(
                    params,
                )} -- status: ${response.status} ${
                    response.statusText
                }, body: ` + JSON.stringify(body, null, 2),
            )
            throw err
        }

        return response
    }

    async getMe() {
        return this.request('getMe')
            .then((x) => x.json())
            .then((x) => x.result as User)
    }

    async setMyCommands(commands: { command: string; description: string }[]) {
        return this.request('setMyCommands', {
            commands: JSON.stringify(commands),
        })
    }

    async getWebhookInfo(): Promise<{ url: string }> {
        const body = await this.request('getWebhookInfo').then((x) => x.json())
        return {
            url: body.result.url,
        }
    }

    async setWebhook({ url }: { url: string }) {
        return this.request('setWebhook', {
            url,
        })
    }

    // https://core.telegram.org/bots/api#sendmessage
    // https://core.telegram.org/bots/api#formatting-options
    async sendMessage(
        chatId: number,
        text: string,
        replyToMessageId?: number,
        silent = false,
        replyMarkup?: { [key: string]: any },
    ): Promise<Message> {
        const body = await this.request('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_to_message_id: replyToMessageId,
            disable_notification: silent,
            reply_markup: JSON.stringify(replyMarkup),
        })
            .then((x) => x.json())
            .then((body) => body.result as Message)
        return body
    }

    async answerCallbackQuery(callbackQueryId: string, text: string) {
        return this.request('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text,
        })
    }

    // If text is too long, sends a chain of messages, each as a reply to the previous message.
    //
    async *sendMessageChain(
        chatId: number,
        text: string,
        replyToMessageId: number,
        // If true, not even the first message will trigger notification
        silent = false,
    ) {
        let prevId = replyToMessageId

        for (const chunk of stringChunksOf(4096, text)) {
            const response = await this.request('sendMessage', {
                chat_id: chatId,
                text: chunk,
                parse_mode: 'HTML',
                reply_to_message_id: prevId,
                // We want to silence notifications on all but the first message
                disable_notification: silent || prevId !== replyToMessageId,
            })
            yield response
            const body = await response.json()
            prevId = body.result.message_id
        }
    }

    async indicateTyping(chatId: number) {
        return this.request('sendChatAction', {
            chat_id: chatId,
            action: 'typing',
        })
    }

    async deleteMessage(chatId: number, messageId: number) {
        return this.request('deleteMessage', {
            chat_id: chatId,
            message_id: messageId,
        })
    }

    // Example response: {
    //       file_id: 'AwACAgEAAxkBAAM2ZBCvNrpnEM5XZOKxoA5qyBtd9h0AAv0CAALeHIFE3k706dMsZlUvBA',
    //       file_unique_id: 'AgAD_QIAAt4cgUQ',
    //       file_size: 6493,
    //       file_path: 'voice/file_0.oga'
    //   }
    async getFile(fileId: string) {
        return this.request('getFile', { file_id: fileId })
            .then((x) => x.json())
            .then((x) => x.result as File)
    }

    async getFileUrl(fileId: string) {
        const file = await this.getFile(fileId)
        const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`
        return url
    }

    // https://core.telegram.org/bots/api#sendvoice
    async sendVoice(
        chatId: number,
        messageId: number,
        caption: string,
        localFilePath: string,
        byteLength: number,
    ) {
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendVoice`

        const formData = new FormData()
        formData.append('chat_id', String(chatId))
        formData.append('reply_to_message_id', String(messageId))
        formData.append('caption', caption.slice(0, 1024))
        // Need to launder our own { stream(): <impl> } into FormData by looking like a File.
        formData.set('voice', {
            //@ts-ignore
            [Symbol.toStringTag]: 'File',
            size: byteLength,
            name: require('path').basename(localFilePath),
            //@ts-ignore
            stream: () => fs.createReadStream(localFilePath),
        })

        const response = await fetch(url, {
            method: 'POST',
            body: formData,
        })
        const responseBody = await response.json()
        // console.log('sendVoice response', response.status, response.statusText)

        // Send additional message if caption was truncated (1024 chars)
        if (caption.length > 1024) {
            for await (const _ of this.sendMessageChain(
                chatId,
                caption.slice(1024),
                responseBody.result.message_id,
                true,
            )) {
            }
        }
    }

    async editMessageText(chatId: number, messageId: number, text: string) {
        return this.request('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
        })
    }

    async editMessageReplyMarkup(
        chatId: number,
        messageId: number,
        inlineKeyboard: { [key: string]: any },
    ) {
        console.log(
            `[editMessageReplyMarkup] chatId=${chatId} messageId=${messageId}`,
        )
        return this.request('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: JSON.stringify({
                inline_keyboard: inlineKeyboard,
            }),
        })
    }
}

function* stringChunksOf(length: number, text: string) {
    let i = 0
    while (true) {
        const slice = text.slice(i * length, (i + 1) * length)
        if (!slice) break
        yield slice
        i++
    }
}

////////////////////////////////////////////////////////////
// Telegram API types
//
// I don't want to go overboard here. These should only be the types that
// my bot needs so I don't have to keep looking at docs.
////////////////////////////////////////////////////////////

// https://core.telegram.org/bots/api#update
export type Update = {
    update_id: number
} & ({ message: Message } | { callback_query: CallbackQuery })

// https://core.telegram.org/bots/api#message
export type Message = {
    message_id: number
    from?: User
    text?: string
    chat?: Chat
    voice?: Voice
}

// https://core.telegram.org/bots/api#voice
type Voice = {
    file_id: string
    file_unique_id: string
    duration: number
    mime_type?: string
    file_size?: number
}

// https://core.telegram.org/bots/api#callbackquery
export type CallbackQuery = {
    id: string
    data?: string
    from?: User
    message?: Message
}

// https://core.telegram.org/bots/api#user
type User = {
    id: number
    username: string
    language_code: string
}

// https://core.telegram.org/bots/api#chat
type Chat = {
    id: number
    type: 'private' | 'group' | 'supergroup' | 'channel'
    username?: string
}

// https://core.telegram.org/bots/api#file
type File = {
    file_id: string
    file_unique_id: string
    file_size: number
    file_path: string
}
