import { CoreBPE, RankMap } from './bpe'
import ranks from './cl100k_base.json'

const special_tokens: any = {
    '<|endoftext|>': 100257,
    '<|fim_prefix|>': 100258,
    '<|fim_middle|>': 100259,
    '<|fim_suffix|>': 100260,
    '<|endofprompt|>': 100276,
}

const special_tokens_map = new Map<string, number>()
for (const text of Object.keys(special_tokens)) {
    special_tokens_map.set(text, special_tokens_map.get(text)!)
}

const pattern =
    /('s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu

const tokenizer = new CoreBPE(RankMap.from(ranks), special_tokens_map, pattern)

export function countTokens(text: string) {
    return tokenizer.encodeOrdinary(text).length
}
