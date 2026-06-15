// ============================================================
// PDF.JS HELPER — Resume Text Extraction
// Requires pdfjs-dist from CDN (loaded in index.html)
// ============================================================

/**
 * Extract text content from a PDF file.
 * @param {File} file - The PDF file to parse
 * @param {Function} [onProgress] - Optional callback: (pageNumber) => void
 * @returns {Promise<string>} Extracted text content
 */
async function extractTextFromPDF(file, onProgress) {
    return new Promise((resolve, reject) => {
        if (!file) {
            reject(new Error('No file provided'));
            return;
        }

        if (file.type && file.type !== 'application/pdf') {
            reject(new Error('Please upload a PDF file. Received: ' + file.type));
            return;
        }

        const reader = new FileReader();

        reader.onload = async (event) => {
            const typedarray = new Uint8Array(event.target.result);
            try {
                const pdf = await pdfjsLib.getDocument({
                    data: typedarray,
                    // Disable range requests for local files
                    disableRange: true
                }).promise;

                let fullText = '';
                const totalPages = pdf.numPages;

                for (let i = 1; i <= totalPages; i++) {
                    if (onProgress) onProgress(i);

                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();

                    // Preserve line structure better by checking y-positions
                    let lastY = null;
                    let pageText = '';

                    textContent.items.forEach(item => {
                        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
                            pageText += '\n'; // New line when y-position changes
                        }
                        pageText += item.str + ' ';
                        lastY = item.transform[5];
                    });

                    fullText += pageText.trim() + '\n\n';
                }

                const cleanedText = fullText
                    .replace(/\n{3,}/g, '\n\n')  // Collapse excessive newlines
                    .trim();

                if (!cleanedText) {
                    console.warn('[PDF] No text extracted. The PDF may be image-based.');
                    resolve('Resume uploaded but no text could be extracted (the PDF may be image-based or scanned).');
                } else {
                    console.log(`[PDF] Extracted ${cleanedText.length} characters from ${totalPages} page(s).`);
                    resolve(cleanedText);
                }

            } catch (error) {
                console.error('[PDF Parse Error]:', error);
                reject(new Error('Failed to parse PDF: ' + error.message + '. Try a different PDF or paste your resume text manually.'));
            }
        };

        reader.onerror = () => reject(new Error('Failed to read the file. Please try again.'));
        reader.readAsArrayBuffer(file);
    });
}
