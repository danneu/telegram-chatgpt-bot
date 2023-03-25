// TODO: Move to db.ts so these can be db.User, db.Prompt types.
export type Prompt = {
    id: number
    prompt: string
    prompt_tokens: number
    answer: string
    answer_tokens: number
}

export type Message = {
    role: 'system' | 'assistant' | 'user'
    content: string
}

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
