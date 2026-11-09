package ai.moeru.airi_pocket

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundReplyTest {
    @Test
    fun `reads a prepared configuration`() {
        val raw = JSONObject()
            .put("enabled", true)
            .put("sessionId", "session-1")
            .put("systemPrompt", "You are AIRI.")
            .put(
                "history",
                JSONArray().put(JSONObject().put("role", "user").put("content", "hi")),
            )
            .put(
                "chat",
                JSONObject()
                    .put("url", "https://example.test/chat/completions")
                    .put("headers", JSONObject().put("Authorization", "Bearer key"))
                    .put("body", """{"model":"m"}"""),
            )
            .put(
                "speech",
                JSONObject()
                    .put("url", "https://example.test/audio/speech")
                    .put("headers", JSONObject())
                    .put("body", """{"model":"tts"}"""),
            )
            .toString()

        val config = BackgroundReplySettings.parseConfig(raw)

        assertTrue(config?.usable == true)
        assertEquals("session-1", config?.sessionId)
        assertEquals(listOf(BackgroundReplyMessage("user", "hi")), config?.history)
        assertEquals("Bearer key", config?.chat?.headers?.get("Authorization"))
        assertEquals("""{"model":"m"}""", config?.chat?.body)
    }

    @Test
    fun `rejects a missing configuration`() {
        assertNull(BackgroundReplySettings.parseConfig(null))
        assertNull(BackgroundReplySettings.parseConfig(""))
    }

    @Test
    fun `rejects a disabled configuration`() {
        val config = BackgroundReplySettings.parseConfig(
            """{"enabled":false,"sessionId":"s","chat":{"url":"u"},"speech":{"url":"u"}}""",
        )

        assertFalse(config?.usable == true)
    }

    @Test
    fun `rejects a configuration without endpoints`() {
        val config = BackgroundReplySettings.parseConfig(
            """{"enabled":true,"sessionId":"s","chat":{"url":""},"speech":{"url":"u"}}""",
        )

        assertFalse(config?.usable == true)
    }

    @Test
    fun `reads string and part content of a chat reply`() {
        assertEquals(
            "hello",
            BackgroundReplyCodec.parseChatReply("""{"choices":[{"message":{"content":"hello"}}]}"""),
        )
        assertEquals(
            "a b",
            BackgroundReplyCodec.parseChatReply(
                """{"choices":[{"message":{"content":[{"type":"text","text":"a "},{"type":"text","text":"b"}]}}]}""",
            ),
        )
    }

    @Test
    fun `rejects an empty chat reply`() {
        assertNull(BackgroundReplyCodec.parseChatReply(""))
        assertNull(BackgroundReplyCodec.parseChatReply("""{"choices":[]}"""))
        assertNull(BackgroundReplyCodec.parseChatReply("""{"choices":[{"message":{"content":"   "}}]}"""))
    }

    @Test
    fun `removes speech markers`() {
        assertEquals(
            "Hello there.",
            BackgroundReplyCodec.stripMarkers("<|EMOTE:happy|>Hello there.<|/EMOTE|>"),
        )
    }

    @Test
    fun `picks an audio extension from the content type`() {
        assertEquals(".wav", BackgroundReplyCodec.extensionOf("audio/wav"))
        assertEquals(".mp3", BackgroundReplyCodec.extensionOf("audio/mpeg"))
        assertEquals(".audio", BackgroundReplyCodec.extensionOf(""))
    }
}