"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteCategory = exports.updateCategory = exports.createCategory = exports.getUserCategories = void 0;
const mongodb_1 = require("mongodb");
const database_1 = require("../middleware/database");
const getUserCategories = async (req, res) => {
    try {
        const db = (0, database_1.getDB)();
        const categories = db.collection('categoryCustom');
        const users = db.collection('users');
        const userCategories = await categories.find({
            userId: new mongodb_1.ObjectId(req.user?.id)
        }).toArray();
        const categoriesWithUserInfo = await Promise.all(userCategories.map(async (category) => {
            const user = await users.findOne({ _id: category.userId }, { projection: { email: 1 } });
            return {
                ...category,
                userEmail: user?.email || 'Unknown'
            };
        }));
        res.json({ categories: categoriesWithUserInfo });
    }
    catch (error) {
        console.error('Error getting user categories:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.getUserCategories = getUserCategories;
const createCategory = async (req, res) => {
    try {
        const { name, iconPath } = req.body;
        if (!name || !iconPath) {
            res.status(400).json({ message: 'Name and iconPath are required' });
            return;
        }
        const db = (0, database_1.getDB)();
        const categories = db.collection('categoryCustom');
        const users = db.collection('users');
        const user = await users.findOne({ _id: new mongodb_1.ObjectId(req.user?.id) }, { projection: { email: 1, name: 1 } });
        const newCategory = {
            userId: new mongodb_1.ObjectId(req.user?.id),
            name: name.trim(),
            iconPath: iconPath.trim(),
            userEmail: user?.email || 'Unknown',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        const result = await categories.insertOne(newCategory);
        res.status(201).json({
            message: 'Category created successfully',
            category: {
                _id: result.insertedId,
                ...newCategory
            }
        });
    }
    catch (error) {
        console.error('Error creating category:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.createCategory = createCategory;
const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, iconPath } = req.body;
        if (!name && !iconPath) {
            res.status(400).json({ message: 'At least name or iconPath is required' });
            return;
        }
        const db = (0, database_1.getDB)();
        const categories = db.collection('categoryCustom');
        const updateData = {
            updatedAt: new Date()
        };
        if (name)
            updateData.name = name.trim();
        if (iconPath)
            updateData.iconPath = iconPath.trim();
        const result = await categories.updateOne({
            _id: new mongodb_1.ObjectId(id),
            userId: new mongodb_1.ObjectId(req.user?.id)
        }, { $set: updateData });
        if (result.matchedCount === 0) {
            res.status(404).json({ message: 'Category not found or access denied' });
            return;
        }
        res.json({ message: 'Category updated successfully' });
    }
    catch (error) {
        console.error('Error updating category:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.updateCategory = updateCategory;
const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const db = (0, database_1.getDB)();
        const categories = db.collection('categoryCustom');
        const result = await categories.deleteOne({
            _id: new mongodb_1.ObjectId(id),
            userId: new mongodb_1.ObjectId(req.user?.id)
        });
        if (result.deletedCount === 0) {
            res.status(404).json({ message: 'Category not found or access denied' });
            return;
        }
        res.json({ message: 'Category deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting category:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.deleteCategory = deleteCategory;
