import { getNeon } from "@/lib/neon";
import { SYSTEM_MESSAGE } from "@/System-prompt";
import { openai } from "@ai-sdk/openai";
import { embed, Message, streamText } from "ai";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const runtime = "edge";

const checkUsage = async () => {
  const headerList = await headers();
  const ip = headerList.get("x-real-ip") || headerList.get("x-forwarded-for");

  const sql = getNeon();

  const searchQuery = `
  SELECT COUNT(*) AS count
  FROM usage
  WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '10 minutes';
  `;

  const searchQueryParams = [ip];

  const searchResult = (await sql(searchQuery, searchQueryParams)) as {
    count: number;
  }[];

  if (searchResult[0].count > 5) {
    throw new Error("Too many requests");
  }

  const insertQuery = `
  INSERT INTO usage (ip_address)
  VALUES ($1);
  `;

  const insertQueryParams = [ip];

  await sql(insertQuery, insertQueryParams);
};

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: Message[] };

  try {
    await checkUsage();
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      {
        error: "Too many requests",
      },
      {
        status: 429,
      }
    );
  }

  const lastMessage = messages[messages.length - 1];
  const userPrompt = lastMessage.content;

  try {
    const { embedding } = await embed({
      model: openai.embedding("text-embedding-ada-002"),
      value: userPrompt,
    });

    const promptEmbeddingFormatted = embedding
      .toString()
      .replace(/\.\.\./g, "");

    const sql = getNeon();

    const insertQuery = `
      SELECT text, file_path
      FROM (
        SELECT text, n_tokens, embeddings, file_path,
        (embeddings <=> '[${promptEmbeddingFormatted}]') AS distances,
        SUM(n_tokens) OVER (ORDER BY (embeddings <=> '[${promptEmbeddingFormatted}]')) as cum_n_tokens
        FROM documents
      ) subquery
      WHERE cum_n_tokens <= $1
      ORDER BY distances ASC;
    `;
    const queryParams = [1700];
    const result = (await sql(insertQuery, queryParams)) as {
      text: string;
      file_path: string;
    }[];

    const formattedResult = result.map((r) => {
      return {
        url: r.file_path.replaceAll("_", "/").replace(".txt", ""),
        content: r.text,
      };
    });

    const context = formattedResult
      .map((r) => {
        return `${r.url}:
      ${r.content}`;
      })
      .join("\n\n");

    interface Message {
      role: string;
      content: string;
    }

    const otherMessages: ChatCompletionMessageParam[] = messages
      .slice(0, messages.length - 1)
      .map((m: Message): ChatCompletionMessageParam => {
        const mess: ChatCompletionMessageParam = {
          role: m.role as "user" | "assistant",
          content: String(m.content),
        };
        return mess;
      });

    interface CoreMessage {
      role: "system" | "user" | "assistant";
      content: string;
    }

    const finalMessages: CoreMessage[] = [
      {
        role: "system",
        content: SYSTEM_MESSAGE,
      },
      ...otherMessages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content as string,
      })),
      {
        role: "system",
        content: `Context:\n${context}`,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];
    const openAIResponse = await streamText({
      model: openai("gpt-4-turbo"),
      messages: finalMessages,
    });

    const originalStream = openAIResponse.toDataStream();

    const modifiedResult = new ReadableStream({
      async start(controller) {
        const reader = originalStream.getReader();

        const finishReasonChunks = [];

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            const customText = '0:"-- Custom string added at the End --"\n';
            console.log("Adding custom string to client:", customText);
            controller.enqueue(new TextEncoder().encode(customText));

            for (const chunk of finishReasonChunks) {
              controller.enqueue(chunk);
            }

            controller.close();
            break;
          }

          const chunkText = new TextDecoder().decode(value);
          if (chunkText.startsWith("e:") || chunkText.startsWith("d:")) {
            console.log("Delaying finishReason chunk:", chunkText);
            finishReasonChunks.push(value);
          } else {
            console.log("Streaming normal chunk:", chunkText);
            controller.enqueue(value);
          }
        }
      },
    });

    return new Response(modifiedResult);
  } catch (error) {
    console.error(error);
  }
}
