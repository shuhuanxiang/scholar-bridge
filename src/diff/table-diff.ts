import type { TableNode } from "../core/ir/nodes";
import { inlineToComparable } from "./node-text";
import type { DiffOptions } from "./structural-diff";
import { diffSequences } from "./lcs";

/**
 * Table cell diff (TECHNICAL_DESIGN.md §9.4): align rows by LCS over per-row
 * content signatures, then compare cells column by column.
 */

export interface CellChange {
  /** Old-table row index for removed rows, new-table row index for added rows. */
  row: number;
  /** Exact old-table row index, when the row exists on the old side. */
  oldRow?: number;
  /** Exact new-table row index, when the row exists on the new side. */
  newRow?: number;
  col: number;      // column index (span-aware position)
  status: "equal" | "changed" | "added" | "removed";
  newText?: string;
  oldText?: string;
  rowSpan?: number;
  colSpan?: number;
}

export interface TableDiffResult {
  changes: CellChange[];
  hasChanges: boolean;
}

export function diffTables(oldTable: TableNode, newTable: TableNode, opts: DiffOptions): TableDiffResult {
  const changes: CellChange[] = [];
  const oldRows = oldTable.rows;
  const newRows = newTable.rows;

  // Align rows by content signature (LCS), so edited key cells stay paired,
  // duplicate keys do not collide and inserted rows do not shift the pairing.
  const oldSigs = oldRows.map((row) => rowSignature(row, opts));
  const newSigs = newRows.map((row) => rowSignature(row, opts));

  const pairings: { oldIdx: number; newIdx: number }[] = [];
  const addedRows: number[] = [];
  const removedRows: number[] = [];
  for (const span of diffSequences(oldSigs, newSigs)) {
    if (span.op === "equal") {
      for (let k = 0; k < span.aLen; k++) {
        pairings.push({ oldIdx: span.aStart + k, newIdx: span.bStart + k });
      }
    } else if (span.op === "insert") {
      for (let k = 0; k < span.bLen; k++) addedRows.push(span.bStart + k);
    } else if (span.op === "delete") {
      for (let k = 0; k < span.aLen; k++) removedRows.push(span.aStart + k);
    } else {
      // replace: pair up in order, leftover rows are removed/added
      const pairCount = Math.min(span.aLen, span.bLen);
      for (let k = 0; k < pairCount; k++) {
        pairings.push({ oldIdx: span.aStart + k, newIdx: span.bStart + k });
      }
      for (let k = pairCount; k < span.aLen; k++) removedRows.push(span.aStart + k);
      for (let k = pairCount; k < span.bLen; k++) addedRows.push(span.bStart + k);
    }
  }

  for (const { oldIdx, newIdx } of pairings) {
    const oldRow = oldRows[oldIdx];
    const newRow = newRows[newIdx];
    // Index the raw arrays: rowSpan shadow cells sit in-position, so raw
    // lengths (not visible-cell counts) define the scan width.
    const width = Math.max(oldRow.length, newRow.length);
    for (let col = 0; col < width; col++) {
      const oldCell = oldRow[col];
      const newCell = newRow[col];
      const oldText = oldCell && !oldCell.rowSpanContinue ? inlineToComparable(oldCell.content, opts) : "";
      const newText = newCell && !newCell.rowSpanContinue ? inlineToComparable(newCell.content, opts) : "";
      // Matching shadows cancel out; a shadow replacing a real cell is a
      // span-structure change.
      if (oldCell?.rowSpanContinue && newCell?.rowSpanContinue) continue;
      if (!oldCell && newCell) {
        changes.push({
          row: newIdx,
          oldRow: oldIdx,
          newRow: newIdx,
          col,
          status: "added",
          newText,
          ...(newCell.rowSpan && newCell.rowSpan > 1 ? { rowSpan: newCell.rowSpan } : {}),
          ...(newCell.colSpan && newCell.colSpan > 1 ? { colSpan: newCell.colSpan } : {}),
        });
      } else if (oldCell && !newCell) {
        changes.push({ row: newIdx, oldRow: oldIdx, newRow: newIdx, col, status: "removed", oldText });
      } else if (oldCell?.rowSpanContinue !== newCell?.rowSpanContinue) {
        changes.push({
          row: newIdx,
          oldRow: oldIdx,
          newRow: newIdx,
          col,
          status: "changed",
          oldText,
          newText,
          ...(newCell?.rowSpan && newCell.rowSpan > 1 ? { rowSpan: newCell.rowSpan } : {}),
        });
      } else if (oldCell && newCell) {
        if (oldText === newText) {
          changes.push({ row: newIdx, oldRow: oldIdx, newRow: newIdx, col, status: "equal", newText });
        } else {
          changes.push({
            row: newIdx,
            oldRow: oldIdx,
            newRow: newIdx,
            col,
            status: "changed",
            oldText,
            newText,
            ...(newCell.rowSpan && newCell.rowSpan > 1 ? { rowSpan: newCell.rowSpan } : {}),
          });
        }
      }
    }
  }
  for (const j of addedRows) {
    const row = newRows[j];
    for (let col = 0; col < row.length; col++) {
      const cell = row[col];
      if (cell.rowSpanContinue) continue;
      changes.push({ row: j, newRow: j, col, status: "added", newText: inlineToComparable(cell.content, opts) });
    }
  }
  for (const i of removedRows) {
    const row = oldRows[i];
    for (let col = 0; col < row.length; col++) {
      const cell = row[col];
      if (cell.rowSpanContinue) continue;
      changes.push({ row: i, oldRow: i, col, status: "removed", oldText: inlineToComparable(cell.content, opts) });
    }
  }

  return {
    changes,
    hasChanges: changes.some((c) => c.status !== "equal"),
  };
}

/**
 * Per-row alignment signature: every raw cell's comparable text, with an
 * explicit marker for rowSpan shadow cells so shadows only ever match shadows.
 * The raw width is part of the signature: rows of different column counts
 * must never align as "equal", or cells would pair up shifted
 * (CODE_REVIEW_R2 §7 leftover).
 */
function rowSignature(row: TableNode["rows"][number], opts: DiffOptions): string {
  return (
    `${row.length}\u0002` +
    row
      .map((cell) => (cell.rowSpanContinue ? "\u0000shadow" : inlineToComparable(cell.content, opts)))
      .join("\u0001")
  );
}
