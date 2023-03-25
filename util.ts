// Groups array members into subarrays of length `chunkSize`.
//
// Example:
//
//     chunksOf(2, ['a', 'b', 'c', 'd', 'e']) -> [['a', 'b'], ['c', 'd'], ['e']]
//
export function chunksOf<T>(chunkSize: number, arr: T[]) {
    const res = []
    for (let i = 0; i < arr.length; i += chunkSize) {
        const chunk = arr.slice(i, i + chunkSize)
        res.push(chunk)
    }
    return res
}
