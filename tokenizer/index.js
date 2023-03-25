"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.countTokens = void 0;
var bpe_1 = require("./bpe");
// import ranks from './cl100k_base.json'
var ranks = require('./cl100k_base.json');
var special_tokens = {
    '<|endoftext|>': 100257,
    '<|fim_prefix|>': 100258,
    '<|fim_middle|>': 100259,
    '<|fim_suffix|>': 100260,
    '<|endofprompt|>': 100276,
};
var special_tokens_map = new Map();
for (var _i = 0, _a = Object.keys(special_tokens); _i < _a.length; _i++) {
    var text = _a[_i];
    special_tokens_map.set(text, special_tokens_map[text]);
}
var pattern = /('s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;
var tokenizer = new bpe_1.CoreBPE(bpe_1.RankMap.from(ranks), special_tokens_map, pattern);
// export default function countTokens(text: string) {
//     return tokenizer.encodeOrdinary(text).length
// }
// Need this to compile into module.exports = function(){}
//@ts-ignore
// export = function countTokens(text: string) {
//     return tokenizer.encodeOrdinary(text).length
// }
function countTokens(text) {
    return tokenizer.encodeOrdinary(text).length;
}
exports.countTokens = countTokens;
