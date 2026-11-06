package ai.moeru.airi_pocket

import android.graphics.Bitmap
import java.util.Locale

/**
 * A 64-bit average hash of a screen frame.
 *
 * The watch-along store computes the same value in TypeScript, so each platform can compare its own frames.
 * A change within a few bits is a cursor or a clock. A new scene changes many bits.
 */
object FrameHash {
    const val SIDE = 8
    const val SIZE = SIDE * SIDE

    /** Returns 16 lowercase hex characters for the luma of an 8 x 8 image in row-major order. */
    fun averageHash(luma: IntArray): String {
        require(luma.size == SIZE) { "The average hash needs $SIZE luma values" }
        val average = luma.average()
        val builder = StringBuilder(16)
        for (chunk in 0 until 4) {
            var value = 0
            for (bit in 0 until 16) {
                val index = chunk * 16 + bit
                if (luma[index] >= average)
                    value = value or (1 shl bit)
            }
            builder.append(String.format(Locale.ROOT, "%04x", value))
        }
        return builder.toString()
    }

    fun averageHash(bitmap: Bitmap): String {
        val small = Bitmap.createScaledBitmap(bitmap, SIDE, SIDE, true)
        val pixels = IntArray(SIZE)
        small.getPixels(pixels, 0, SIDE, 0, 0, SIDE, SIDE)
        if (small !== bitmap)
            small.recycle()

        val luma = IntArray(SIZE) { index ->
            val color = pixels[index]
            val red = (color shr 16) and 0xFF
            val green = (color shr 8) and 0xFF
            val blue = color and 0xFF
            (red * 299 + green * 587 + blue * 114) / 1000
        }
        return averageHash(luma)
    }
}