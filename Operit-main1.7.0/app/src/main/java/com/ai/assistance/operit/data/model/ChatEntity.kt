package com.ai.assistance.operit.data.model

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.time.LocalDateTime
import java.util.UUID

/** 聊天实体类，用于Room数据库存储聊天元数据 */
@Entity(tableName = "chats")
data class ChatEntity(
        @PrimaryKey val id: String = UUID.randomUUID().toString(),
        val title: String,
        val createdAt: Long = System.currentTimeMillis(),
        val updatedAt: Long = System.currentTimeMillis(),
        val inputTokens: Int = 0,
        val outputTokens: Int = 0,
        val currentWindowSize: Int = 0,
        val group: String? = null,
        val displayOrder: Long = -createdAt,
        val workspace: String? = null,
        val parentChatId: String? = null,
        val characterCardName: String? = null
) {
    /** 转换为ChatHistory对象（供UI层使用） */
    fun toChatHistory(messages: List<ChatMessage>): ChatHistory {
        return ChatHistory(
                id = id,
                title = title,
                messages = messages,
                createdAt = LocalDateTime.now(), // 需要进一步转换
                updatedAt = LocalDateTime.now(), // 需要进一步转换
                inputTokens = inputTokens,
                outputTokens = outputTokens,
                currentWindowSize = currentWindowSize,
                group = group,
                displayOrder = displayOrder,
                workspace = workspace,
                parentChatId = parentChatId,
                characterCardName = characterCardName
        )
    }

    companion object {
        /** 从ChatHistory创建ChatEntity */
        fun fromChatHistory(chatHistory: ChatHistory): ChatEntity {
            val now = System.currentTimeMillis()
            return ChatEntity(
                    id = chatHistory.id,
                    title = chatHistory.title,
                    createdAt =
                            chatHistory
                                    .createdAt
                                    ?.toEpochSecond(java.time.ZoneOffset.UTC)
                                    ?.times(1000)
                                    ?: now,
                    updatedAt =
                            chatHistory
                                    .updatedAt
                                    ?.toEpochSecond(java.time.ZoneOffset.UTC)
                                    ?.times(1000)
                                    ?: now,
                    inputTokens = chatHistory.inputTokens,
                    outputTokens = chatHistory.outputTokens,
                    currentWindowSize = chatHistory.currentWindowSize,
                    group = chatHistory.group,
                    displayOrder = if (chatHistory.displayOrder != 0L) chatHistory.displayOrder else -now,
                    workspace = chatHistory.workspace,
                    parentChatId = chatHistory.parentChatId,
                    characterCardName = chatHistory.characterCardName
            )
        }
    }
}
