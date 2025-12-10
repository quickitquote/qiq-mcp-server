# Agent Builder Workflow (Copy-Paste Configs)

This guide provides exact node schemas and edge mappings needed to integrate OpenAI Agent Builder with our MCP server.

## Node Order
1. plan_boq
2. search_planning
3. execute_search
4. MCP (tools/call → typesense_search)
5. aggregate_results
6. final_response

## Critical Fix
- `execute_search` must output a JSON object with `mcp_input` containing: `category`, `keywords`, `quantity`, `duration_years`.
- Do NOT use `output_text` here; set Output format to JSON.

## execute_search Output Schema (JSON)
```json
{
  "mcp_input": {
    "category": "security_software",
    "keywords": ["KL4066IAVFS", "kaspersky"],
    "quantity": 25,
    "duration_years": 2
  }
}
```

## Edge Mappings
- execute_search → MCP:
  - Map `mcp_input.category` → MCP arg `category`
  - Map `mcp_input.keywords` → MCP arg `keywords`
  - Map `mcp_input.quantity` → MCP arg `quantity`
  - Map `mcp_input.duration_years` → MCP arg `duration_years`

## MCP Tool Invocation
- Method: `tools/call`
- Tool: `typesense_search`
- Args: as mapped above

## aggregate_results
- Input: MCP `products`
- Behavior: Combine, dedupe, and score with `qiq_scoring` if needed.

## Notes
- Identifier-like queries should include `mpn_normalized`, `object_id`, `name`.
- Our server prioritizes these in `query_by` for improved relevance.
