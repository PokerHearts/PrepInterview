// PDF.js helper for extracting text from resumes
// Requires pdfjs-dist from CDN (loaded in index.html)

async function extractTextFromPDF(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            const typedarray = new Uint8Array(event.target.result);
            try {
                const pdf = await pdfjsLib.getDocument(typedarray).promise;
                let fullText = "";
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();
                    const pageText = textContent.items.map(item => item.str).join(" ");
                    fullText += pageText + "\n";
                }
                resolve(fullText);
            } catch (error) {
                reject("Error parsing PDF: " + error.message);
            }
        };
        reader.onerror = () => reject("File reading error");
        reader.readAsArrayBuffer(file);
    });
}
