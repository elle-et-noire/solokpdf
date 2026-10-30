# SolokPDF review — 2026-10-29

Reviewed `ee2cdc1e7` and every commit in `ee2cdc1e7..0e219f451`: Light Gray, count prefixes, shortcuts dialog and VS entries, keyboard scroll distance, Vim mode and link hints, update checks, restore session, and keyboard help. The refactor is `ee040d363`.

## Findings

| Severity | Location                                                 | Scenario                                                                                                                          | Resolution                                                         |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Medium   | `src/VimKeys.cpp:331`, `src/shared/Accelerators.cpp:198` | JIS `:`, `'`, and backtick use different virtual keys from US; Vim commands fail. `/` and `?` also depended on physical OEM keys. | Match produced characters; JIS layout regression test. `d6515434a` |
| Medium   | `src/shared/LinkFollow.cpp:265`                          | Pressing `f` on a page with no links left Vim hint mode set; later plain keys were consumed.                                      | Clear the mode through the normal stop path. `30f0033b2`           |
| Medium   | `src/VimKeys.cpp:300`, `src/VimKeys.cpp:396`             | `Ctrl+E` and `Ctrl+Y` ignored `KeyScrollLineAmount`.                                                                              | Use the keyboard scroll helper. `90adca0ab`                        |
| Medium   | `src/SumatraPDF.cpp:176`, `src/ng/SessionState.cpp:432`  | `RestoreSession = true` reopened documents even when file history was disabled and the checkbox was unavailable.                  | Require `RememberOpenedFiles` at startup. `dc785dbda`              |
| Medium   | `src/VimKeys.cpp:346`                                    | JIS `;` is `VK_OEM_PLUS`; the Vim hint matcher only accepted the US OEM key, so a `;` hint could be cancelled.                    | Capture the produced character. `b682c262a`                        |
| Medium   | `src/VimKeys.cpp:198`                                    | Enter or Escape during IME composition in the `:` edit submitted or closed the command before the IME handled it.                 | Pass both keys to the edit during composition. `0593bce2d`         |

No further actionable defect was found in the theme, shortcuts dialog, VS entries, update-check guard, or keyboard-help changes. Non-Vim bindings remain in the original accelerator layer. Mark jumps check the page against the current document before setting scroll state. The startup and Vim regressions above were observed failing before their fixes and passing afterward.
