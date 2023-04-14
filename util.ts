// Groups array members into subarrays of length `chunkSize`.
//
// Example:
//
//     chunksOf(2, ['a', 'b', 'c', 'd', 'e']) -> [['a', 'b'], ['c', 'd'], ['e']]
//
export function chunksOf<T>(chunkSize: number, arr: T[]): T[][] {
    const res: T[][] = []
    for (let i = 0; i < arr.length; i += chunkSize) {
        const chunk = arr.slice(i, i + chunkSize)
        res.push(chunk)
    }
    return res
}

// Take the first N letters of a string but stops at a space boundary right
// before reaching the limit instead of breaking up the word at the limit.
export function splitTake(limit: number, text: string): string {
    const words = text.split(' ')
    let result = ''
    let length = 0

    for (const word of words) {
        const newLength = length + word.length + (length > 0 ? 1 : 0)
        if (newLength > limit) break
        result += (length > 0 ? ' ' : '') + word
        length = newLength
    }

    return result
}
