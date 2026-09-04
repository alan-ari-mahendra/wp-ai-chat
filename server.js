import "dotenv/config"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import express from "express"
import cors from "cors"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "system-prompt.txt"), "utf8")

const app = express()
app.use(cors({ origin: "*" }))
app.use(express.json({ limit: "10mb" }))

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })
const adminSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Auth middleware ────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" })

  const jwt = auth.slice(7)
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  })
  const { data: { user }, error } = await userClient.auth.getUser()
  if (error || !user) return res.status(401).json({ error: "Unauthorized" })

  req.user = user
  next()
}

function buildContextMessage(context) {
  let msg = `\n\n## Current Project Context\n`
  msg += `- Today's Date: ${new Date().toISOString().split("T")[0]}\n`
  if (context.projectName)        msg += `- Project Name: ${context.projectName}\n`
  if (context.projectNickname)    msg += `- Project Nickname: ${context.projectNickname}\n`
  if (context.contractNumber)     msg += `- Contract Number: ${context.contractNumber}\n`
  if (context.projectDescription) msg += `- Description: ${context.projectDescription}\n`
  if (context.projectStatus)      msg += `- Project Status: ${context.projectStatus}\n`
  if (context.projectStartDate)   msg += `- Project Start Date: ${context.projectStartDate}\n`
  if (context.projectEndDate)     msg += `- Project End Date: ${context.projectEndDate}\n`
  if (context.projectStartDate && context.projectEndDate) {
    const months = Math.round(
      (new Date(context.projectEndDate) - new Date(context.projectStartDate))
      / (1000 * 60 * 60 * 24 * 30.44)
    )
    msg += `- Project Duration: ~${months} months\n`
  }
  if (context.originalContractValue) msg += `- Original Contract Value: RM ${Number(context.originalContractValue).toLocaleString()}\n`
  if (context.provisionalSumAmount)  msg += `- Provisional Sum: RM ${Number(context.provisionalSumAmount).toLocaleString()}\n`
  if (context.contractSum)           msg += `- Contract Sum (BoQ Total): RM ${Number(context.contractSum).toLocaleString()}\n`
  if (context.items?.length) {
    msg += `\n### BoQ Items (${context.items.length} items):\n`
    msg += "| ID | Item No | Description | Amount (RM) | Unit | Qty | Rate | Start Date | End Date | Duration | Predecessor |\n"
    msg += "|---|---------|-------------|-------------|------|-----|------|------------|----------|----------|-------------|\n"
    for (const item of context.items) {
      msg += `| ${item.id} | ${item.boqItemNo} | ${item.description} | ${item.amount} | ${item.unit || '-'} | ${item.quantity || '-'} | ${item.rate || '-'} | ${item.startDate || '-'} | ${item.endDate || '-'} | ${item.duration || '-'} | ${item.predecessor || '-'} |\n`
    }
  }
  if (context.headers?.length) {
    msg += `\n### Headers (reference only — not directly editable items)\n`
    msg += "When user references a header, update its children items listed below.\n"
    for (const h of context.headers) {
      msg += h.childrenNos.length
        ? `- ${h.itemNo} (${h.description}): children = ${h.childrenNos.join(", ")}\n`
        : `- ${h.itemNo} (${h.description}): no children items\n`
    }
  }
  return msg
}

// ── Main endpoint ──────────────────────────────────────────────────
app.post("/wp-ai-chat", requireAuth, async (req, res) => {
  const startTime = Date.now()
  const { message, context, history, versionId, projectId, isContinue, skipSave } = req.body

  if (!message) return res.status(400).json({ error: "Message is required" })

  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  try {
    const contextMessage = context ? buildContextMessage(context) : ""
    const messages = [
      ...(history || []).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message + contextMessage },
    ]

    console.log(`[WP AI] items=${context?.items?.length ?? 0} msgLen=${(message + contextMessage).length}`)

    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      messages,
    })

    let fullText = ""

    stream.on("text", (delta) => {
      fullText += delta
      send({ type: "delta", text: delta })
    })

    const finalMsg = await stream.finalMessage()
    console.log(`[WP AI] done — input=${finalMsg.usage?.input_tokens} output=${finalMsg.usage?.output_tokens} stop=${finalMsg.stop_reason} elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`)

    // Log JSON stats
    const jsonMatch2 = fullText.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch2) {
      try {
        const parsed2 = JSON.parse(jsonMatch2[1])
        const items2 = parsed2.items || []
        const withDates = Array.isArray(items2[0])
          ? items2.filter(r => r[1] !== null).length  // compact format: col 1 = start_date
          : items2.filter(i => i.start_date).length
        console.log(`[WP AI] JSON — total_items=${items2.length} with_dates=${withDates} complete=${parsed2.complete}`)
      } catch (e) {
        console.log(`[WP AI] JSON parse failed: ${e.message}`)
      }
    } else {
      console.log(`[WP AI] No JSON block in response`)
    }

    if (versionId && projectId && !skipSave) {
      let appliedJson = null
      const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1])
          if (parsed.action === "update_items" && Array.isArray(parsed.items)) {
            if (parsed.cols && Array.isArray(parsed.cols)) {
              parsed.items = parsed.items.map(row => {
                const obj = {}
                for (let i = 0; i < parsed.cols.length; i++) {
                  if (row[i] !== null && row[i] !== undefined) obj[parsed.cols[i]] = row[i]
                }
                return obj
              })
              delete parsed.cols
            }
            appliedJson = parsed
          }
        } catch (e) {
          console.error("[WP AI] JSON parse error:", e.message)
        }
      }

      if (!isContinue) {
        await adminSupabase.from("work_programme_chat_messages").insert({
          version_id: versionId, project_id: projectId,
          role: "user", content: message, created_by: req.user.id,
        })
      }
      await adminSupabase.from("work_programme_chat_messages").insert({
        version_id: versionId, project_id: projectId,
        role: "assistant", content: fullText,
        applied_json: appliedJson, created_by: req.user.id,
      })
    }

    send({ type: "done" })
    res.end()
  } catch (err) {
    console.error("[WP AI] Error:", err.message, err.status)
    const isOverloaded = err.status === 529 || err.message?.includes("Overloaded")
    send({
      type: "error",
      error: isOverloaded
        ? "AI service is currently overloaded. Please try again in a few minutes."
        : "AI service encountered an error. Please try again.",
    })
    res.end()
  }
})

app.listen(process.env.PORT || 3001, () => {
  console.log(`WP AI server running on port ${process.env.PORT || 3001}`)
})
