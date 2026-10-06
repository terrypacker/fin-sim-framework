/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * msbs-valuation-factors.js — Table 1, "Valuation factors — preserved benefits", of
 * Schedule 1 Part 4 to the Family Law (Superannuation) (Methods and Factors for Valuing
 * Particular Superannuation Interests) Approval 2025, compilation No. 1
 * (`docs/au-tax/FLSR-2025/F2026C00100VOL03.txt`, Division 4.4). Parsed from that text, never
 * from model output (design 119 §6.4).
 *
 * Only the MALE columns: the total superannuation balance reads the Approval "as if the
 * member were male" (ITAR 1997 reg 307-230A.04(3)(g)). Columns are FDB and UDB factors, each
 * for officers and for persons other than officers at the date membership ceased. The first
 * row is "20 or less"; the table ends at 65.
 *
 *   [age, FDB officer, FDB other, UDB officer, UDB other]
 */
export const MSBS_PRESERVED_FACTORS = Object.freeze([
  [20, 1.3968, 1.2268, 0.3658, 0.3213],
  [21, 1.3953, 1.2259, 0.3797, 0.3336],
  [22, 1.3939, 1.2251, 0.3941, 0.3463],
  [23, 1.3923, 1.2242, 0.4090, 0.3596],
  [24, 1.3908, 1.2233, 0.4245, 0.3734],
  [25, 1.3893, 1.2224, 0.4406, 0.3877],
  [26, 1.3877, 1.2216, 0.4572, 0.4025],
  [27, 1.3861, 1.2207, 0.4746, 0.4179],
  [28, 1.3846, 1.2197, 0.4925, 0.4339],
  [29, 1.3830, 1.2188, 0.5111, 0.4505],
  [30, 1.3813, 1.2179, 0.5305, 0.4677],
  [31, 1.3797, 1.2170, 0.5505, 0.4856],
  [32, 1.3781, 1.2160, 0.5713, 0.5041],
  [33, 1.3764, 1.2151, 0.5929, 0.5234],
  [34, 1.3747, 1.2141, 0.6153, 0.5434],
  [35, 1.3730, 1.2132, 0.6385, 0.5642],
  [36, 1.3713, 1.2122, 0.6626, 0.5857],
  [37, 1.3696, 1.2112, 0.6876, 0.6081],
  [38, 1.3678, 1.2102, 0.7135, 0.6313],
  [39, 1.3661, 1.2092, 0.7404, 0.6554],
  [40, 1.3643, 1.2082, 0.7683, 0.6804],
  [41, 1.3595, 1.2054, 0.7955, 0.7053],
  [42, 1.3547, 1.2027, 0.8236, 0.7312],
  [43, 1.3498, 1.1999, 0.8526, 0.7579],
  [44, 1.3448, 1.1971, 0.8826, 0.7857],
  [45, 1.3399, 1.1942, 0.9137, 0.8144],
  [46, 1.3348, 1.1913, 0.9458, 0.8441],
  [47, 1.3297, 1.1884, 0.9789, 0.8749],
  [48, 1.3246, 1.1855, 1.0132, 0.9068],
  [49, 1.3194, 1.1825, 1.0486, 0.9398],
  [50, 1.3141, 1.1795, 1.0852, 0.9740],
  [51, 1.3025, 1.1729, 1.1176, 1.0064],
  [52, 1.2908, 1.1662, 1.1508, 1.0397],
  [53, 1.2790, 1.1594, 1.1847, 1.0740],
  [54, 1.2670, 1.1526, 1.2194, 1.1093],
  [55, 1.2549, 1.1457, 1.2549, 1.1457],
  [56, 1.2510, 1.1434, 1.2510, 1.1434],
  [57, 1.2466, 1.1409, 1.2466, 1.1409],
  [58, 1.2417, 1.1381, 1.2417, 1.1381],
  [59, 1.2363, 1.1350, 1.2363, 1.1350],
  [60, 1.2304, 1.1317, 1.2304, 1.1317],
  [61, 1.2240, 1.1280, 1.2240, 1.1280],
  [62, 1.2172, 1.1241, 1.2172, 1.1241],
  [63, 1.2098, 1.1199, 1.2098, 1.1199],
  [64, 1.2019, 1.1154, 1.2019, 1.1154],
  [65, 1.1935, 1.1106, 1.1935, 1.1106],
].map(r => Object.freeze(r)));
