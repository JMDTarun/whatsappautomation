import { ContentVariator } from 'baileys-antiban';

export const contentVariator = new ContentVariator({
    zeroWidthChars: true,
    punctuationVariation: true,
    emojiPadding: false,
    synonyms: false,
});
