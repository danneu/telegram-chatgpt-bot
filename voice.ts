// TODO: Finish
// https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support?tabs=tts
// demo: https://speech.microsoft.com/portal/voicegallery
//
// This maps 2-letter language code into default voices. I use this to automatically change
// the voice if the bot is responding in a language different from the one configured at `chat.voice`.
const DEFAULT_VOICES = {
    // Afrikaans
    af: ['af-ZA-AdriNeural', 'af-ZA-WillemNeural'],
    // Catalan
    ca: ['ca-ES-AlbaNeural', 'ca-ES-EnricNeural'],
    // Czech
    cs: ['cs-CZ-VlastaNeural', 'cs-CZ-AntoninNeural'],
    // German
    de: ['de-DE-AmalaNeural', 'de-DE-BerndNeural'],
    // English
    en: [
        'en-US-JaneNeural', // mejor que jenny
        'en-US-BrandonNeural',
    ],
    // Spanish
    es: [
        'es-HN-KarlaNeural', // más animada
        'es-MX-CecilioNeural',
    ],
    // French
    fr: ['fr-FR-BrigitteNeural', 'fr-FR-AlainNeural'],
    // Italian
    it: ['it-IT-ElsaNeural', 'it-IT-BenignoNeural'],
    // Japanese
    ja: ['ja-JP-AoiNeural', 'ja-JP-DaichiNeural'],
    // Korean
    ko: ['ko-KR-JiMinNeural', 'ko-KR-BongJinNeural'],
    // Portuguese
    pt: ['pt-BR-BrendaNeural', 'pt-BR-AntonioNeural'],
}

export function voiceFromLanguageCode(code: string) {
    const match = DEFAULT_VOICES[code.toLowerCase()]
    if (!match) return
    const [female, male] = match
    return female
}
