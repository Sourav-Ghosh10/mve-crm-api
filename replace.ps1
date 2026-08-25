$employeeFile = "..\mve-crm-employee\src\pages\Payroll\PayslipDetail.tsx"
$adminFile = "..\mve-crm-admin\src\pages\Payroll\Payslips\PayslipDetailsView.tsx"

$empContent = Get-Content -Path $employeeFile -Raw
$empContent = $empContent -replace '<h1 className="text-xl font-black tracking-wide text-\[#174a7c\]">\s*MY VIRTUAL EMPLOYEE\s*</h1>', '<img src="/logo.png" alt="Pro Staff Logo" className="h-10 w-auto" />'
$empContent = $empContent -replace 'signature when electronically verified\. \| My Virtual Employee', 'signature when electronically verified. | Pro Staff'
Set-Content -Path $employeeFile -Value $empContent -NoNewline

$admContent = Get-Content -Path $adminFile -Raw
$admContent = $admContent -replace '<h1 className="text-xl font-black tracking-wide text-\[#174a7c\]">\s*MY VIRTUAL EMPLOYEE\s*</h1>', '<img src="/logo.png" alt="Pro Staff Logo" className="h-10 w-auto" />'
$admContent = $admContent -replace 'signature when electronically verified\. \| My Virtual Employee', 'signature when electronically verified. | Pro Staff'
Set-Content -Path $adminFile -Value $admContent -NoNewline
