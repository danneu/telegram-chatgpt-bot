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
