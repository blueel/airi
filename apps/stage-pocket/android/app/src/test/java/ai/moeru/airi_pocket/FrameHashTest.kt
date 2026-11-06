package ai.moeru.airi_pocket

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameHashTest {
    @Test
    fun `sets every bit when every pixel is equal`() {
        assertEquals("ffffffffffffffff", FrameHash.averageHash(IntArray(64) { 128 }))
    }

    @Test
    fun `sets the brighter half of a split image`() {
        val luma = IntArray(64) { index -> if (index < 32) 0 else 255 }
        assertEquals("00000000ffffffff", FrameHash.averageHash(luma))
    }
}