import { getNeon } from "@/lib/neon";
import { SYSTEM_MESSAGE } from "@/System-prompt";
import { openai } from "@ai-sdk/openai";
import { embed, StreamData, streamText } from "ai";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

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
  const { messages } = await req.json();

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
    const finalMessages: Array<ChatCompletionMessageParam> = [
      {
        role: "system",
        content: SYSTEM_MESSAGE,
      },
      ...otherMessages,
      {
        role: "system",
        content: `Context:
        ${context}`,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const openAIResponse = await streamText({
      model: openai("gpt-4-turbo"),
      messages,
    });

    const originalStream = new OpenAIStream(openAIResponse);

    const editedStream = new ReadableStream({
      start(controller) {
        const reader = originalStream.getReader();
        read();

        function read() {
          reader
            .read()
            .then(({ done, value }: { done: boolean; value: Uint8Array }) => {
              if (done) {
                controller.enqueue(`\n\n### Source

              ${formattedResult
                .map((r) => `* [${r.url}](${r.url})\n`)
                .join("")}`);
                controller.close();
                return;
              }

              controller.enqueue(value);
              read();
            });
        }
      },
    });

    const data = new StreamData();

    const stream = openAIResponse.toDataStream({
      data,
      getErrorMessage: (error) => `Error: ${error}`,
    });

    return new NextResponse(editedStream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  } catch {}
}
