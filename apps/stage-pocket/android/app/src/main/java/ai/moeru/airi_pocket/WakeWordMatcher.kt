package ai.moeru.airi_pocket

/** One matched wake phrase and the command that follows it in the same utterance. */
data class WakeWordMatch(
    val phrase: String,
    val remainder: String,
) {
    val hasCommand: Boolean
        get() = remainder.isNotEmpty()
}

/**
 * Matches the written wake words at the start of a speech transcript.
 *
 * Android speech recognition returns text, not the token probabilities of the Web keyword spotter. The match ignores
 * case, spaces, and punctuation, so "Hey, AIRI!" and "hey airi" select the same phrase. A phrase matches only at the
 * start of the transcript, so a mention in the middle of a sentence cannot start a turn.
 */
object WakeWordMatcher {
    /**
     * Returns the longest configured phrase at the start of `transcript`, with the text after it.
     * Returns null when no phrase matches.
     */
    fun match(transcript: String, phrases: List<String>): WakeWordMatch? {
        if (transcript.isBlank())
            return null

        val normalized = normalizeWithMap(transcript)
        if (normalized.text.isEmpty())
            return null

        val candidates = phrases
            .map { normalize(it) }
            .filter { it.isNotEmpty() }
            .distinct()
            .sortedByDescending { it.length }

        for (phrase in candidates) {
            if (!normalized.text.startsWith(phrase))
                continue

            val phraseEnd = normalized.originalIndices[phrase.length - 1]
            val remainder = transcript
                .substring(phraseEnd + 1)
                .trimStart { !it.isLetterOrDigit() }
                .trim()
            return WakeWordMatch(phrase, remainder)
        }
        return null
    }

    /** Lowercase letters and digits only. CJK characters count as letters. */
    internal fun normalize(text: String): String {
        val builder = StringBuilder(text.length)
        for (char in text) {
            if (char.isLetterOrDigit())
                builder.append(char.lowercaseChar())
        }
        return builder.toString()
    }

    private data class NormalizedTranscript(
        val text: String,
        val originalIndices: IntArray,
    )

    private fun normalizeWithMap(text: String): NormalizedTranscript {
        val builder = StringBuilder(text.length)
        val indices = ArrayList<Int>(text.length)
        text.forEachIndexed { index, char ->
            if (char.isLetterOrDigit()) {
                builder.append(char.lowercaseChar())
                indices.add(index)
            }
        }
        return NormalizedTranscript(builder.toString(), indices.toIntArray())
    }
}