"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoreBPE = exports.RankMap = void 0;
var MAX_NUM_THREADS = 128;
var RankMap = /** @class */ (function () {
    function RankMap() {
        this.values = new Map();
    }
    RankMap.from = function (texts) {
        var map = new RankMap();
        for (var i = 0; i < texts.length; i++) {
            map.values.set(texts[i], i);
        }
        return map;
    };
    RankMap.prototype.set = function (bytes, rank) {
        var key = Buffer.from(bytes).toString();
        this.values.set(key, rank);
    };
    RankMap.prototype.get = function (bytes) {
        var key = Buffer.from(bytes).toString();
        return this.values.get(key);
    };
    RankMap.prototype.keys = function () {
        return Array.from(this.values.keys()).map(function (k) { return Buffer.from(k); });
    };
    RankMap.prototype.inverted = function () {
        var inverted = new Map();
        for (var _i = 0, _a = Array.from(this.values.entries()); _i < _a.length; _i++) {
            var _b = _a[_i], key = _b[0], value = _b[1];
            inverted.set(value, new Uint8Array(Buffer.from(key)));
        }
        return inverted;
    };
    return RankMap;
}());
exports.RankMap = RankMap;
function bytePairMerge(piece, ranks) {
    var parts = Array.from({ length: piece.length }, function (_, i) { return ({
        start: i,
        end: i + 1,
    }); });
    while (true) {
        if (parts.length === 1) {
            break;
        }
        var minRank = null;
        for (var i = 0; i < parts.length - 1; i++) {
            var rank = ranks.get(piece.slice(parts[i].start, parts[i + 1].end));
            if (rank === undefined) {
                continue;
            }
            if (minRank === null || rank < minRank[0]) {
                minRank = [rank, i];
            }
        }
        if (minRank !== null) {
            var _ = minRank[0], i = minRank[1];
            parts[i] = { start: parts[i].start, end: parts[i + 1].end };
            parts.splice(i + 1, 1);
        }
        else {
            break;
        }
    }
    return parts;
}
function bytePairEncode(piece, ranks) {
    if (piece.length === 1) {
        return [ranks.get(piece)];
    }
    return bytePairMerge(piece, ranks).map(function (p) { return ranks.get(piece.slice(p.start, p.end)); });
}
function bytePairSplit(piece, ranks) {
    if (piece.length === 1) {
        return [piece];
    }
    return bytePairMerge(piece, ranks).map(function (p) { return piece.slice(p.start, p.end); });
}
var CoreBPE = /** @class */ (function () {
    function CoreBPE(encoder, specialTokensEncoder, regex) {
        var specialRegex = new RegExp(Array.from(specialTokensEncoder.keys())
            .map(function (s) { return s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); })
            .join('|'));
        var decoder = encoder.inverted();
        var specialTokensDecoder = new Map(Array.from(specialTokensEncoder.entries()).map(function (_a) {
            var k = _a[0], v = _a[1];
            return [
                v,
                new Uint8Array(Buffer.from(k)),
            ];
        }));
        var sortedTokenBytes = Array.from(encoder.keys());
        sortedTokenBytes.sort(function (a, b) { return Buffer.compare(a, b); });
        this.encoder = encoder;
        this.specialTokensEncoder = specialTokensEncoder;
        this.decoder = decoder;
        this.specialTokensDecoder = specialTokensDecoder;
        this.regexTls = Array(MAX_NUM_THREADS).fill(regex);
        this.specialRegexTls = Array(MAX_NUM_THREADS).fill(specialRegex);
        this.sortedTokenBytes = sortedTokenBytes;
    }
    CoreBPE.prototype._getTlRegex = function () {
        return this.regexTls[Math.floor(Math.random() * MAX_NUM_THREADS)];
    };
    CoreBPE.prototype._getTlSpecialRegex = function () {
        return this.specialRegexTls[Math.floor(Math.random() * MAX_NUM_THREADS)];
    };
    CoreBPE.prototype._decodeNative = function (tokens) {
        var ret = [];
        for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
            var token = tokens_1[_i];
            var tokenBytes = this.decoder.get(token) || this.specialTokensDecoder.get(token);
            ret.push.apply(ret, Array.from(tokenBytes));
        }
        return new Uint8Array(ret);
    };
    CoreBPE.prototype._encodeOrdinaryNative = function (text) {
        var regex = this._getTlRegex();
        var ret = [];
        var match;
        while ((match = regex.exec(text)) !== null) {
            var piece = new Uint8Array(Buffer.from(match[0]));
            var token = this.encoder.get(piece);
            if (token !== undefined) {
                ret.push(token);
                continue;
            }
            ret.push.apply(ret, bytePairEncode(piece, this.encoder));
        }
        return ret;
    };
    CoreBPE.prototype._encodeNative = function (text, allowedSpecial) {
        var specialRegex = this._getTlSpecialRegex();
        var regex = this._getTlRegex();
        var ret = [];
        var start = 0;
        var lastPieceTokenLen = 0;
        while (true) {
            var nextSpecial = void 0;
            var startFind = start;
            while (true) {
                nextSpecial = specialRegex.exec(text.slice(startFind));
                if (nextSpecial === null ||
                    allowedSpecial.has(nextSpecial[0])) {
                    break;
                }
                startFind = nextSpecial.index + 1;
            }
            var end = nextSpecial === null ? text.length : nextSpecial.index;
            var match = void 0;
            while ((match = regex.exec(text.slice(start, end))) !== null) {
                var piece_1 = new Uint8Array(Buffer.from(match[0]));
                var token_1 = this.encoder.get(piece_1);
                if (token_1 !== undefined) {
                    lastPieceTokenLen = 1;
                    ret.push(token_1);
                    continue;
                }
                var tokens = bytePairEncode(piece_1, this.encoder);
                lastPieceTokenLen = tokens.length;
                ret.push.apply(ret, tokens);
            }
            if (nextSpecial === null) {
                break;
            }
            var piece = nextSpecial[0];
            var token = this.specialTokensEncoder.get(piece);
            ret.push(token);
            start = nextSpecial.index + piece.length;
            lastPieceTokenLen = 0;
        }
        return [ret, lastPieceTokenLen];
    };
    CoreBPE.prototype.encodeOrdinary = function (text) {
        return this._encodeOrdinaryNative(text);
    };
    CoreBPE.prototype.encode = function (text, allowedSpecial) {
        return this._encodeNative(text, allowedSpecial)[0];
    };
    CoreBPE.prototype.encodeWithUnstable = function (text, allowedSpecial) {
        throw new Error('Not implemented');
    };
    CoreBPE.prototype.encodeSingleToken = function (piece) {
        var token = this.encoder.get(piece);
        if (token !== undefined) {
            return token;
        }
        var pieceStr = Buffer.from(piece).toString('utf-8');
        if (this.specialTokensEncoder.has(pieceStr)) {
            return this.specialTokensEncoder.get(pieceStr);
        }
        throw new Error('Key not found');
    };
    CoreBPE.prototype.encodeSinglePiece = function (piece) {
        var token = this.encoder.get(piece);
        if (token !== undefined) {
            return [token];
        }
        return bytePairEncode(piece, this.encoder);
    };
    CoreBPE.prototype.decodeBytes = function (tokens) {
        return this._decodeNative(tokens);
    };
    CoreBPE.prototype.decodeSingleTokenBytes = function (token) {
        var bytes = this.decoder.get(token) || this.specialTokensDecoder.get(token);
        if (bytes !== undefined) {
            return bytes;
        }
        throw new Error('Key not found');
    };
    CoreBPE.prototype.tokenByteValues = function () {
        return this.sortedTokenBytes;
    };
    return CoreBPE;
}());
exports.CoreBPE = CoreBPE;
