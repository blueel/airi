package ai.moeru.airi_pocket

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WakeWordMatcherTest {
    @Test
    fun `matches English words without case and punctuation`() {
        val match = WakeWordMatcher.match("Hey, AIRI! What's the weather?", listOf("hey airi"))

        assertEquals("What's the weather?", match?.remainder)
        assertTrue(match?.hasCommand == true)
    }

    @Test
    fun `matches Chinese words without spaces`() {
        val match = WakeWordMatcher.match("嘿 爱 理，今天天气怎么样？", listOf("嘿爱理"))

        assertEquals("今天天气怎么样？", match?.remainder)
    }

    @Test
    fun `matches a wake word without a command`() {
        val match = WakeWordMatcher.match("Hey AIRI", listOf("hey airi"))

        assertTrue(match != null)
        assertFalse(match?.hasCommand == true)
        assertEquals("", match?.remainder)
    }

    @Test
    fun `does not match a phrase in the middle of a sentence`() {
        assertNull(WakeWordMatcher.match("please ask hey airi", listOf("hey airi")))
    }

    @Test
    fun `prefers the longest phrase`() {
        val match = WakeWordMatcher.match("hey airi what is this", listOf("hey", "hey airi"))

        assertEquals("what is this", match?.remainder)
    }

    @Test
    fun `ignores blank input and empty phrases`() {
        assertNull(WakeWordMatcher.match("   ", listOf("hey airi")))
        assertNull(WakeWordMatcher.match("hey airi", emptyList()))
    }

    @Test
    fun `drops separators before the command`() {
        val match = WakeWordMatcher.match("Hey AIRI — open the camera", listOf("hey airi"))

        assertEquals("open the camera", match?.remainder)
    }
}