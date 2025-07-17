"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const categories_1 = require("../api/categories");
const router = (0, express_1.Router)();
// Получить все категории пользователя
router.get('/', auth_1.authenticateToken, categories_1.getUserCategories);
// Создать новую категорию
router.post('/', auth_1.authenticateToken, categories_1.createCategory);
// Обновить категорию
router.put('/:id', auth_1.authenticateToken, categories_1.updateCategory);
// Удалить категорию
router.delete('/:id', auth_1.authenticateToken, categories_1.deleteCategory);
exports.default = router;
