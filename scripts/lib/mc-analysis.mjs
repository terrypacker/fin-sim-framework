/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * mc-analysis.mjs — the lab's entry point to the shared MC analysis module.
 *
 * The functions moved to `src/finance/monte-carlo/mc-analysis.js` (design 100 §2.1) so the
 * MC tab and `mc-report.mjs` compute every band and rescue count the same way. This file
 * stays so the scripts' imports do not change.
 */

export * from '../../src/finance/monte-carlo/mc-analysis.js';
