import "dotenv/config"
import { readFileSync, writeFileSync, appendFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import express from "express"
import cors from "cors"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT_PATH = join(__dirname, "system-prompt.txt")
const LOG_PATH = join(__dirname, "wp-ai-latest.log")

// Read per-request so system-prompt.txt changes take effect without server restart
const getSystemPrompt = () => readFileSync(SYSTEM_PROMPT_PATH, "utf8")

// File logger — overwrites on new request, appends within same request
let _logFile = false
function initLog(header) {
  writeFileSync(LOG_PATH, header + "\n", "utf8")
  _logFile = true
}
function flog(...args) {
  const line = args.join(" ")
  console.log(line)
  if (_logFile) appendFileSync(LOG_PATH, line + "\n", "utf8")
}

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

// Keywords that mean "all items" — skip filtering
const ALL_SCOPE_KEYWORDS = /\b(all items|all activities|all tasks|everything|entire|whole project|full schedule|generate schedule|plan work programme|back-load|front-load|recalculate all|redistribute)\b/i

function filterContextItems(message, context) {
  const items = context?.items
  if (!items?.length) return context

  // If message implies full scope, send everything
  if (ALL_SCOPE_KEYWORDS.test(message)) return context

  // Extract item numbers mentioned in message (e.g. "1.14", "3.2.1.1", "2.2.3")
  const mentioned = new Set(
    [...message.matchAll(/\b(\d+(?:\.\d+)+)\b/g)].map(m => m[1])
  )
  if (mentioned.size === 0) return context

  // Build boqItemNo → item map + successor map
  const byItemNo = new Map(items.map(i => [i.boqItemNo, i]))
  const successors = new Map() // itemNo → [successorItemNos]
  for (const item of items) {
    if (!item.predecessor) continue
    const predNo = item.predecessor.split(":")[0].trim()
    if (!successors.has(predNo)) successors.set(predNo, [])
    successors.get(predNo).push(item.boqItemNo)
  }

  // BFS: collect mentioned items + all transitive successors
  const relevant = new Set()
  const queue = [...mentioned]
  while (queue.length) {
    const no = queue.shift()
    if (relevant.has(no)) continue
    relevant.add(no)
    for (const succ of (successors.get(no) || [])) {
      if (!relevant.has(succ)) queue.push(succ)
    }
  }

  // Also include direct predecessors of mentioned items (for date context)
  for (const no of mentioned) {
    const item = byItemNo.get(no)
    if (item?.predecessor) {
      const predNo = item.predecessor.split(":")[0].trim()
      relevant.add(predNo)
    }
  }

  const filtered = items.filter(i => relevant.has(i.boqItemNo))

  // If filtering leaves > 80% of items, not worth filtering — send all
  if (filtered.length > items.length * 0.8) return context

  console.log(`[WP AI] Context filtered: ${filtered.length}/${items.length} items (mentioned: ${[...mentioned].join(", ")})`)
  return { ...context, items: filtered }
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
    msg += "| Item No | Description | Amount (RM) | Unit | Qty | Rate | Start Date | End Date | Duration | Predecessor |\n"
    msg += "|---------|-------------|-------------|------|-----|------|------------|----------|----------|-------------|\n"
    const itemNoCount = {}
    for (const item of context.items) {
      itemNoCount[item.boqItemNo] = (itemNoCount[item.boqItemNo] || 0) + 1
    }
    const itemNoSeen = {}
    for (const item of context.items) {
      let displayNo = item.boqItemNo
      if (itemNoCount[item.boqItemNo] > 1) {
        itemNoSeen[item.boqItemNo] = (itemNoSeen[item.boqItemNo] || 0) + 1
        displayNo = `${item.boqItemNo}_${itemNoSeen[item.boqItemNo]}`
      }
      msg += `| ${displayNo} | ${item.description} | ${item.amount} | ${item.unit || '-'} | ${item.quantity || '-'} | ${item.rate || '-'} | ${item.startDate || '-'} | ${item.endDate || '-'} | ${item.duration || '-'} | ${item.predecessor || '-'} |\n`
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
    const filteredContext = context ? filterContextItems(message, context) : context
    const contextMessage = filteredContext ? buildContextMessage(filteredContext) : ""
    const messages = [
      ...(history || []).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message + contextMessage },
    ]

    const systemPrompt = getSystemPrompt()

    // Init log file — overwrites previous request's log
    initLog([
      `=== WP AI Request @ ${new Date().toISOString()} ===`,
      `project=${projectId} version=${versionId} items_total=${context?.items?.length ?? 0} items_sent=${filteredContext?.items?.length ?? 0}`,
      `msgLen=${(message + contextMessage).length}`,
      ``,
      `=== RAW USER MESSAGE ===`,
      message,
      `=== END RAW USER MESSAGE ===`,
      ``,
      `=== CONTEXT (first 3000 chars) ===`,
      contextMessage.slice(0, 3000),
      `=== END CONTEXT ===`,
    ].join("\n"))
    flog(`[WP AI] items_sent=${filteredContext?.items?.length ?? 0}/${context?.items?.length ?? 0} msgLen=${(message + contextMessage).length}`)

    // Build itemNo → UUID lookup map from FULL context (not filtered) for correct resolution
    // Build itemNo → UUID lookup map (with suffix for duplicate boqItemNos)
    const itemNoToId = new Map()
    const _noCount = {}
    const _noSeen = {}
    for (const item of (context?.items || [])) {
      if (!item.boqItemNo || !item.id) continue
      _noCount[item.boqItemNo] = (_noCount[item.boqItemNo] || 0) + 1
    }
    for (const item of (context?.items || [])) {
      if (!item.boqItemNo || !item.id) continue
      let key = item.boqItemNo
      if (_noCount[item.boqItemNo] > 1) {
        _noSeen[item.boqItemNo] = (_noSeen[item.boqItemNo] || 0) + 1
        key = `${item.boqItemNo}_${_noSeen[item.boqItemNo]}`
      }
      itemNoToId.set(key, item.id)
    }

    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64000,
      system: systemPrompt,
      messages,
    })

    let fullText = ""

    stream.on("text", (delta) => {
      fullText += delta
      send({ type: "delta", text: delta })
    })

    const finalMsg = await stream.finalMessage()
    flog(`[WP AI] done — input=${finalMsg.usage?.input_tokens} output=${finalMsg.usage?.output_tokens} stop=${finalMsg.stop_reason} elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`)

    // Log raw AI response
    if (_logFile) {
      appendFileSync(LOG_PATH, `\n=== RAW AI RESPONSE ===\n${fullText}\n=== END RAW AI RESPONSE ===\n\n`, "utf8")
    }

    // Log JSON stats + preview first 20 items
    const jsonMatch2 = fullText.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch2) {
      try {
        const parsed2 = JSON.parse(jsonMatch2[1])
        const items2 = parsed2.items || []
        const cols2 = parsed2.cols || []
        const withDates = Array.isArray(items2[0])
          ? items2.filter(r => r[1] !== null).length
          : items2.filter(i => i.start_date).length
        const withPred = Array.isArray(items2[0]) && cols2.includes("predecessor")
          ? items2.filter(r => r[cols2.indexOf("predecessor")] !== null).length
          : items2.filter(i => i.predecessor).length
        console.log(`[WP AI] JSON — total_items=${items2.length} with_dates=${withDates} with_pred=${withPred} complete=${parsed2.complete}`)
        if (_logFile) appendFileSync(LOG_PATH, `[WP AI] JSON — total_items=${items2.length} with_dates=${withDates} with_pred=${withPred} complete=${parsed2.complete}\n`, "utf8")
        console.log(`[WP AI] cols=${JSON.stringify(cols2)}`)
        if (_logFile) appendFileSync(LOG_PATH, `[WP AI] cols=${JSON.stringify(cols2)}\n`, "utf8")

        const parseRow = (row) => {
          if (Array.isArray(row) && cols2.length) {
            const obj = {}
            for (let i = 0; i < cols2.length; i++) obj[cols2[i]] = row[i]
            return obj
          }
          return row
        }
        const itemKey = cols2.includes("item_no") ? "item_no" : "id"

        // Console: first 20 only
        console.log(`[WP AI] --- first 20 items preview ---`)
        for (const row of items2.slice(0, 20)) {
          const obj = parseRow(row)
          console.log(`[WP AI]   ${itemKey}=${obj[itemKey]} start=${obj.start_date} end=${obj.end_date} dur=${obj.duration_days} pred=${obj.predecessor}`)
        }
        console.log(`[WP AI] --- end preview (console) ---`)

        // File: ALL items
        if (_logFile) {
          appendFileSync(LOG_PATH, `[WP AI] --- all ${items2.length} items ---\n`, "utf8")
          for (const row of items2) {
            const obj = parseRow(row)
            appendFileSync(LOG_PATH, `  ${itemKey}=${obj[itemKey]} start=${obj.start_date} end=${obj.end_date} dur=${obj.duration_days} pred=${obj.predecessor}\n`, "utf8")
          }
          appendFileSync(LOG_PATH, `[WP AI] --- end all items ---\n`, "utf8")
        }
      } catch (e) {
        flog(`[WP AI] JSON parse failed: ${e.message}`)
      }
    } else {
      flog(`[WP AI] No JSON block in response`)
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
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            const before = parsed.items.length
            // Resolve item_no → UUID if AI used boqItemNo as key
            // After cols expansion, key field is "item_no" (not "id"), so item.id is undefined
            parsed.items = parsed.items.map(item => {
              const lookupKey = item.id || item.item_no
              if (!lookupKey || !UUID_RE.test(lookupKey)) {
                const resolved = itemNoToId.get(lookupKey)
                if (resolved) {
                  const { item_no: _drop, ...rest } = item
                  return { ...rest, id: resolved }
                }
                return null // skip — cannot resolve
              }
              return item
            }).filter(Boolean)
            const unresolved = before - parsed.items.length
            if (unresolved > 0) flog(`[WP AI] Skipped ${unresolved} rows with unresolvable IDs`)
            // Remove duplicates — keep first occurrence
            const seenIds = new Set()
            parsed.items = parsed.items.filter(item => {
              if (seenIds.has(item.id)) return false
              seenIds.add(item.id)
              return true
            })
            flog(`[WP AI] Applied ${parsed.items.length} valid rows (of ${before} total)`)
            appliedJson = parsed
          }
        } catch (e) {
          flog(`[WP AI] JSON parse error: ${e.message}`)
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
    flog(`[WP AI] Error: ${err.message} status=${err.status}`)
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
