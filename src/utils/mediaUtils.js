import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
import { v2 as cloudinary } from 'cloudinary';

const execPromise = util.promisify(exec);

export async function compressPDF(buffer) {
    if (buffer.length <= 10 * 1024 * 1024) return buffer;

    console.log(`Compressing PDF (Original Size: ${buffer.length} bytes)...`);
    const tempDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const uniqueId = crypto.randomBytes(4).toString('hex');
    const inputPath = path.join(tempDir, `input_${uniqueId}.pdf`);
    const outputPath = path.join(tempDir, `output_${uniqueId}.pdf`);

    try {
        fs.writeFileSync(inputPath, buffer);
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`);

        const compressedBuffer = fs.readFileSync(outputPath);
        console.log(`PDF Compressed. New Size: ${compressedBuffer.length} bytes`);

        return compressedBuffer.length < buffer.length ? compressedBuffer : buffer;
    } catch (err) {
        console.error('PDF compression failed:', err);
        return buffer;
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
}

export async function uploadToCloudinary(buffer, mimetype, filename) {
    console.log(`Starting upload to Cloudinary: ${filename}, size: ${buffer.length} bytes, type: ${mimetype}`);

    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'auto' },
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload failed:', error);
                    return reject(new Error(`Cloudinary upload failed: ${error.message}`));
                }
                console.log(`Cloudinary upload successful: ${result.secure_url}`);
                resolve(result.secure_url);
            }
        );

        const timeoutId = setTimeout(() => reject(new Error('Cloudinary upload timed out (5m)')), 300000);

        uploadStream.on('finish', () => clearTimeout(timeoutId));
        uploadStream.on('error', () => clearTimeout(timeoutId));

        uploadStream.end(buffer);
    });
}
