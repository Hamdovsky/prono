// @ts-nocheck
import {  body, validationResult  } from 'express-validator'

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() })
  }
  next()
}

const validate = {
  deployConfig: [
    body('strategy').optional().isIn(['Safe', 'Balanced', 'Aggressive']),
    body('autoPurge').optional().isBoolean(),
    body('thresholds').optional().isObject(),
    handleValidationErrors,
  ],
  seedMatch: [
    body('homeTeam').optional().isString().trim().notEmpty(),
    body('awayTeam').optional().isString().trim().notEmpty(),
    body('league').optional().isString().trim(),
    body('startTimestamp').optional().isNumeric(),
    handleValidationErrors,
  ],
}

export = { validate }
