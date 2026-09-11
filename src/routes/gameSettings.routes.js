import express from 'express'
import {
  getPublicGame,
  getPublicGames,
} from '../controllers/gameSettings.controller.js'

const router = express.Router()

router.get('/', getPublicGames)
router.get('/:gameKey', getPublicGame)

export default router
