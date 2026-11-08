# Glazed AI (OpenGlazed)

Glazed AI is a self-hosted document assistant. A team uploads its documents and gets an assistant that answers questions from them, cites the file and page it used, and runs on the team's own model provider and database. The open-source project is called OpenGlazed; the app itself is branded Glazed AI. It was built by Alexander Guille Penuliar.

Repository: https://github.com/agilap/OpenGlazed

## Who Glazed AI is for

Glazed AI is for teams that want answers from their own policies, handbooks, product notes, FAQs and data without sending everything to a third-party chatbot service. Typical uses are a support team answering from its policy documents, a company sharing an "ask our docs" chat with customers, and developers adding document Q&A to their own app through the API.

## How it works

1. Sign up and name a workspace.
2. Upload documents, or paste text.
3. Each document is parsed, split into chunks and embedded. PDFs are split page by page so answers can cite the page.
4. When someone asks a question, the assistant searches the workspace's documents, then answers only from what it found and cites the sources.
5. If the documents do not cover the question, the assistant says so instead of guessing.

A document is usually ready to answer from within a few seconds of upload.

## Supported documents

- PDF (text-based; one section per page, cited as "file.pdf p.3")
- Word documents (DOCX)
- Markdown (MD), split by its headings
- Plain text (TXT)
- CSV, one section per row
- JSON, one section per array item
- Pasted text

Each file can be up to 18 MB. Scanned PDFs without a text layer are rejected with a clear message, because Glazed AI does not run OCR. Files are checked by extension and by their file signature, so a renamed file of the wrong type is rejected.

## Where people ask questions

### Shareable chat

Every workspace has a public chat page at /embed/{workspace id} and an embeddable widget added to any website with one script tag. Visitors can type immediately. A small optional card offers to collect their name and email for a follow-up; visitors can dismiss it with "Not now". Conversations persist across page reloads.

### Team chat

Staff use an internal team chat inside the workspace. It answers from the same documents and can also look at recent shared-chat conversations and collected contacts. Team chats are kept as threads.

### Developer API

Other applications can use Glazed AI through a REST API. Keys are created in the workspace's API section, shown only once, scoped to one workspace, stored as SHA-256 hashes and limited to 60 requests per minute. Requests send the key as `Authorization: Bearer ogk_...`.

- POST /api/v1/ask with a question returns the answer, citations, an "unanswered" flag, a session id for follow-up questions and a trace id.
- GET, POST and DELETE under /api/v1/documents list, upload, read and remove documents.

## The workspace dashboard

The dashboard is a sidebar app with one view per page:

- Overview: number of ready documents, questions answered, the share of conversations with a question the documents could not answer, median answer time, recent questions and a documents summary.
- Documents: upload, watch indexing status and remove files.
- Conversations: shared-chat conversations with their full transcripts.
- Leads: names and emails left through the follow-up card.
- Team chat: the internal assistant.
- Traces: per-request retrieval details for debugging answers.
- API: create and revoke API keys, with ready-to-copy examples.
- Embed: the embed snippet and a live preview of the shareable chat.

## How answers stay grounded

Retrieval combines two searches: dense vector search with pgvector and keyword (full-text) search in PostgreSQL. The two result lists are merged with Reciprocal Rank Fusion. A small tool-calling agent decides when to search, and falls back to plain retrieve-then-answer on model providers without tool calling. Answers cite numbered sources, and retrieved text is treated as reference material, never as instructions.

## Models and privacy

Glazed AI is model-agnostic. It works with any OpenAI-compatible API, configured with three settings: the API URL, the API key and the model name. Examples are OpenAI, OpenRouter, Groq, Gemini, Anthropic and a local Ollama server. This demo runs on OpenAI with gpt-4o-mini for answers and text-embedding-3-small for embeddings.

Switching the embedding model is safe: on restart Glazed AI detects the new vector size and re-embeds all stored content from its saved text, with no re-upload needed.

All documents, chunks, conversations and accounts are stored in the owner's own PostgreSQL database with the pgvector extension, run locally through Docker. Only the text needed for embeddings and answers is sent to the chosen model provider.

## Accounts and security

- Accounts use email and password. Passwords are hashed with scrypt, and sessions are stored in PostgreSQL behind an HTTP-only, SameSite=Strict cookie that expires after seven days (marked Secure when served over HTTPS with COOKIE_SECURE=true).
- Each workspace belongs to one account; other accounts get "not found" for its data, documents and keys.
- Sign-in attempts are rate limited.
- Password reset and email verification are not built yet.

## Tech stack

Node.js and Express backend, React and Vite frontend, PostgreSQL with pgvector, the OpenAI SDK against any OpenAI-compatible endpoint, pdf-parse for PDFs and mammoth for Word documents. It runs locally with Docker Compose for the database.

## Limitations

- No OCR for scanned PDFs.
- Up to 18 MB per file.
- Documents are processed one at a time per workspace on a single server, so it should run as a single API instance.
- The "unanswered" signal depends on the model admitting the documents do not cover a question.
- No password reset or email verification yet.

## Frequently asked questions

### Does Glazed AI make things up?

It is instructed to answer only from the retrieved documents and to cite them. When the documents do not cover a question, it says so. No assistant is perfect, so the cited sources are shown with every answer for checking.

### Can I use it without OpenAI?

Yes. Any OpenAI-compatible provider works, including a local Ollama server for fully offline use.

### Where is my data stored?

In your own PostgreSQL database. Glazed AI has no hosted cloud that stores your documents.

### Is it free?

OpenGlazed is open source and self-hosted. You pay only for the model provider you choose.

### Who built it?

Alexander Guille Penuliar, a software engineer from Batangas City, Philippines.
