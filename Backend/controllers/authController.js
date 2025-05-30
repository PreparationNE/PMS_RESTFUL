const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { hashPassword, comparePassword, generateToken, errorResponse, successResponse } = require('../utils/helper');
const { sendEmail } = require('../utils/email');
const { generateOTP } = require('../utils/otp');

// Helper function to execute queries
const executeQuery = async (query, params) => {
    const [result] = await pool.query(query, params);
    return result;
};

// User Registration
exports.register = async (req, res) => {
    try {
        const { name, email, password, plateNumber, preferredEntryTime, preferredExitTime } = req.body;

        // Validate input
        if (!name || !email || !password || !plateNumber || !preferredEntryTime || !preferredExitTime) {
            return errorResponse(res, 'All fields are required', 400);
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return errorResponse(res, 'Invalid email format', 400);
        }

        // Validate entry and exit times
        if (new Date(preferredExitTime) <= new Date(preferredEntryTime)) {
            return errorResponse(res, 'Exit time must be after entry time', 400);
        }

        // Check if user already exists
        const existingUsers = await executeQuery(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        if (existingUsers.length > 0) {
            return errorResponse(res, 'Email already registered', 400);
        }

        // Hash password and create user
        const hashedPassword = await hashPassword(password);
        const result = await executeQuery(
            'INSERT INTO users (name, email, password, plateNumber, preferredEntryTime, preferredExitTime, status, isEmailVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email, hashedPassword, plateNumber, preferredEntryTime, preferredExitTime, 'pending', false]
        );

        // Generate and send OTP
        const otp = generateOTP();
        await executeQuery(
            'INSERT INTO otps (email, code, type, role, expiresAt) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
            [email, otp, 'verification', 'user']
        );

        await sendEmail(email, 'Verify Your Email', `Your verification code is: ${otp}`);

        return successResponse(res, 'Registration successful. Please verify your email.', {
            userId: result.insertId
        });
    } catch (error) {
        console.error('Registration error:', error);
        return errorResponse(res, 'Error in registration', 500, error);
    }
};

// User Login
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find and verify user
        const users = await executeQuery(
            'SELECT * FROM users WHERE email = ? AND role = ?',
            [email, 'user']
        );

        if (users.length === 0) {
            return errorResponse(res, 'Invalid credentials', 401);
        }

        const user = users[0];

        if (!user.isEmailVerified) {
            return errorResponse(res, 'Please verify your email first', 401);
        }

        if (user.status !== 'approved') {
            return errorResponse(res, 'Your account is pending approval', 401);
        }

        const isPasswordValid = await comparePassword(password, user.password);
        if (!isPasswordValid) {
            return errorResponse(res, 'Invalid credentials', 401);
        }

        const token = generateToken({
            id: user.id,
            email: user.email,
            role: 'user'
        });

        return successResponse(res, 'Login successful', {
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                plateNumber: user.plateNumber
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return errorResponse(res, 'Error in login', 500, error);
    }
};

// Admin Registration
exports.adminRegister = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Check if admin exists
        const existingAdmins = await executeQuery(
            'SELECT * FROM admins WHERE email = ?',
            [email]
        );

        if (existingAdmins.length > 0) {
            return errorResponse(res, 'Admin with this email already exists', 400);
        }

        // Create admin
        const hashedPassword = await hashPassword(password);
        const result = await executeQuery(
            'INSERT INTO admins (name, email, password, role, isEmailVerified) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, 'admin', false]
        );

        // Generate and send OTP
        const otp = generateOTP();
        await executeQuery(
            'INSERT INTO otps (email, code, type, role, expiresAt) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
            [email, otp, 'verification', 'admin']
        );

        await sendEmail(email, 'Verify Your Admin Email', `Your verification code is: ${otp}`);

        return successResponse(res, 'Admin registration successful. Please verify your email.', {
            adminId: result.insertId
        });
    } catch (error) {
        console.error('Admin registration error:', error);
        return errorResponse(res, 'Error in admin registration', 500, error);
    }
};

// Admin Login
exports.adminLogin = async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('Attempting admin login for:', email);

        // Find and verify admin
        const admins = await executeQuery(
            'SELECT * FROM admins WHERE email = ?',
            [email]
        );

        console.log('Found admins:', admins.length);

        if (admins.length === 0) {
            return errorResponse(res, 'Invalid credentials', 401);
        }

        const admin = admins[0];

        if (!admin.isEmailVerified) {
            return errorResponse(res, 'Please verify your email first', 401);
        }

        const isPasswordValid = await comparePassword(password, admin.password);
        console.log('Password validation result:', isPasswordValid);

        if (!isPasswordValid) {
            return errorResponse(res, 'Invalid credentials', 401);
        }

        console.log('JWT_SECRET:', process.env.JWT_SECRET);
        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET is not defined');
            return errorResponse(res, 'Server configuration error', 500);
        }

        const tokenPayload = {
            id: admin.id,
            email: admin.email,
            role: 'admin'
        };
        console.log('Token payload:', tokenPayload);

        const token = generateToken(tokenPayload);
        console.log('Generated token:', token);

        return successResponse(res, 'Login successful', {
            token,
            admin: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: 'admin'
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
        return errorResponse(res, 'Error in admin login', 500, error);
    }
};

// Verify User Email
exports.verifyUserEmail = async (req, res) => {
    try {
        const { email, code } = req.body;

        // Verify OTP
        const otps = await executeQuery(
            'SELECT * FROM otps WHERE email = ? AND code = ? AND type = ? AND role = ? AND isUsed = false AND expiresAt > NOW() ORDER BY createdAt DESC LIMIT 1',
            [email, code, 'verification', 'user']
        );

        if (otps.length === 0) {
            return errorResponse(res, 'Invalid or expired verification code', 400);
        }

        const otp = otps[0];

        // Find user
        const users = await executeQuery(
            'SELECT * FROM users WHERE email = ? AND role = ?',
            [email, 'user']
        );

        if (users.length === 0) {
            return errorResponse(res, 'User not found', 404);
        }

        // Update verification status
        await executeQuery(
            'UPDATE users SET isEmailVerified = true WHERE email = ? AND role = ?',
            [email, 'user']
        );

        await executeQuery(
            'UPDATE otps SET isUsed = true WHERE id = ?',
            [otp.id]
        );

        return successResponse(res, 'Email verified successfully');
    } catch (error) {
        console.error('Email verification error:', error);
        return errorResponse(res, 'Error in email verification', 500, error);
    }
};

// Verify Admin Email
exports.verifyAdminEmail = async (req, res) => {
    try {
        const { email, code } = req.body;

        // Verify OTP
        const otps = await executeQuery(
            'SELECT * FROM otps WHERE email = ? AND code = ? AND type = ? AND role = ? AND isUsed = false AND expiresAt > NOW() ORDER BY createdAt DESC LIMIT 1',
            [email, code, 'verification', 'admin']
        );

        if (otps.length === 0) {
            return errorResponse(res, 'Invalid or expired verification code', 400);
        }

        const otp = otps[0];

        // Find admin
        const admins = await executeQuery(
            'SELECT * FROM admins WHERE email = ?',
            [email]
        );

        if (admins.length === 0) {
            return errorResponse(res, 'Admin not found', 404);
        }

        // Update verification status
        await executeQuery(
            'UPDATE admins SET isEmailVerified = true WHERE email = ?',
            [email]
        );

        await executeQuery(
            'UPDATE otps SET isUsed = true WHERE id = ?',
            [otp.id]
        );

        return successResponse(res, 'Email verified successfully');
    } catch (error) {
        console.error('Admin email verification error:', error);
        return errorResponse(res, 'Error in admin email verification', 500, error);
    }
};

// Forgot Password
exports.forgotPassword = async (req, res) => {
    try {
        const { email, role } = req.body;

        // Validate role
        if (!['user', 'admin'].includes(role)) {
            return errorResponse(res, 'Invalid role specified', 400);
        }

        // Check if user/admin exists
        const table = role === 'admin' ? 'admins' : 'users';
        const users = await executeQuery(
            `SELECT * FROM ${table} WHERE email = ?`,
            [email]
        );

        if (users.length === 0) {
            return errorResponse(res, 'Account not found', 404);
        }

        const user = users[0];

        // Check if email is verified
        if (!user.isEmailVerified) {
            return errorResponse(res, 'Please verify your email first', 401);
        }

        // Generate and send OTP
        const otp = generateOTP();
        await executeQuery(
            'INSERT INTO otps (email, code, type, role, expiresAt) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
            [email, otp, 'reset', role]
        );

        // Send email with reset code
        const emailSubject = 'Reset Your Password';
        const emailBody = `
            <h2>Password Reset Request</h2>
            <p>You have requested to reset your password. Use the following code to reset your password:</p>
            <h1 style="color: #4CAF50; font-size: 24px; letter-spacing: 2px;">${otp}</h1>
            <p>This code will expire in 10 minutes.</p>
            <p>If you didn't request this, please ignore this email.</p>
        `;

        await sendEmail(email, emailSubject, emailBody);

        return successResponse(res, 'Password reset code sent to your email');
    } catch (error) {
        console.error('Forgot password error:', error);
        return errorResponse(res, 'Error in forgot password process', 500, error);
    }
};

// Reset Password
exports.resetPassword = async (req, res) => {
    try {
        const { email, code, newPassword, role } = req.body;

        // Validate role
        if (!['user', 'admin'].includes(role)) {
            return errorResponse(res, 'Invalid role specified', 400);
        }

        // Validate password
        if (!newPassword || newPassword.length < 8) {
            return errorResponse(res, 'Password must be at least 8 characters long', 400);
        }

        // Verify OTP
        const otps = await executeQuery(
            'SELECT * FROM otps WHERE email = ? AND code = ? AND type = ? AND role = ? AND isUsed = false AND expiresAt > NOW() ORDER BY createdAt DESC LIMIT 1',
            [email, code, 'reset', role]
        );

        if (otps.length === 0) {
            return errorResponse(res, 'Invalid or expired reset code', 400);
        }

        const otp = otps[0];

        // Check if user/admin exists
        const table = role === 'admin' ? 'admins' : 'users';
        const users = await executeQuery(
            `SELECT * FROM ${table} WHERE email = ?`,
            [email]
        );

        if (users.length === 0) {
            return errorResponse(res, 'Account not found', 404);
        }

        // Update password
        const hashedPassword = await hashPassword(newPassword);
        await executeQuery(
            `UPDATE ${table} SET password = ? WHERE email = ?`,
            [hashedPassword, email]
        );

        // Mark OTP as used
        await executeQuery(
            'UPDATE otps SET isUsed = true WHERE id = ?',
            [otp.id]
        );

        // Send confirmation email
        const emailSubject = 'Password Reset Successful';
        const emailBody = `
            <h2>Password Reset Successful</h2>
            <p>Your password has been successfully reset.</p>
            <p>If you didn't make this change, please contact support immediately.</p>
        `;

        await sendEmail(email, emailSubject, emailBody);

        return successResponse(res, 'Password reset successful');
    } catch (error) {
        console.error('Reset password error:', error);
        return errorResponse(res, 'Error in password reset', 500, error);
    }
};

// Get Profile
exports.getProfile = async (req, res) => {
    try {
        const users = await executeQuery(
            'SELECT id, name, email, role, plateNumber, status FROM users WHERE id = ?',
            [req.user.id]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json(users[0]);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ message: 'Error fetching profile' });
    }
};

// Update Profile
exports.updateProfile = async (req, res) => {
    try {
        const { name, email } = req.body;

        // Check email availability
        if (email !== req.user.email) {
            const existingUsers = await executeQuery(
                'SELECT * FROM users WHERE email = ? AND id != ?',
                [email, req.user.id]
            );

            if (existingUsers.length > 0) {
                return res.status(400).json({ message: 'Email already in use' });
            }
        }

        // Update profile
        await executeQuery(
            'UPDATE users SET name = ?, email = ? WHERE id = ?',
            [name, email, req.user.id]
        );

        const updatedUser = await executeQuery(
            'SELECT id, name, email, role, plateNumber, status FROM users WHERE id = ?',
            [req.user.id]
        );

        res.json({
            message: 'Profile updated successfully',
            user: updatedUser[0]
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Error updating profile' });
    }
};

// Change Password
exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        // Get user
        const users = await executeQuery(
            'SELECT * FROM users WHERE id = ?',
            [req.user.id]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = users[0];

        // Verify current password
        const isPasswordValid = await comparePassword(currentPassword, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        // Update password
        const hashedPassword = await hashPassword(newPassword);
        await executeQuery(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedPassword, req.user.id]
        );

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Error changing password' });
    }
};